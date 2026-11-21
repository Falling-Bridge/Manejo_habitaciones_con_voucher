# Sistema Distribuido Resiliente: Gestión de Reservas Hoteleras (Forma H)

## 1. Introducción y Arquitectura del Sistema
El presente documento detalla la arquitectura, implementación y guía de validación del sistema distribuido desarrollado para la gestión transaccional de reservas hoteleras. 

El sistema resuelve el problema de consistencia distribuida (evitar cobros sin reservas o reservas sin cobros) mediante la implementación de los siguientes patrones de diseño:
*   **API Gateway (Puerto 8080):** Único punto de entrada. Centraliza la autenticación (JWT), aplica Rate Limiting y enruta las peticiones.
*   **BFF - Backend For Frontend (Puerto 8090):** Agrega datos de múltiples microservicios en una sola respuesta para el cliente.
*   **Saga Orchestrator (Puerto 3004):** Coordina la transacción distribuida y gestiona las compensaciones.
*   **Microservicios de Dominio:** Habitaciones (3001), Pagos (3002) y Confirmación (3003). Cada uno con su propia base de datos SQLite.
*   **Patrones de Resiliencia:** Timeout, Circuit Breaker (Opossum) y Bulkhead aplicados sobre la dependencia frágil (Pagos).

### Despliegue del Sistema
Para iniciar todos los contenedores, sitúese en la raíz del proyecto y ejecute:
```bash
docker compose up --build
```

Si necesita reiniciar el entorno a su estado original (eliminando reservas, pagos y bloqueos de las bases de datos), ejecute:
```bash
docker compose down -v
docker compose up --build
```

---

## 2. Diccionario de Variables y Endpoints (El "Dominio")

A continuación, se define el "dominio" matemático de cada variable para los endpoints principales.

### 2.1 Autenticación (Gateway)
El Gateway requiere un token JWT para autorizar peticiones en el resto del sistema.

**Endpoint:** `POST http://localhost:8080/auth/token`
**Cuerpo (Body JSON):**
```json
{
  "user": "ana",
  "role": "guest"
}
```

| Variable | Tipo | Dominio (Valores válidos) | Descripción |
| :--- | :--- | :--- | :--- |
| `user` | String | Cualquier cadena de texto (ej. `"ana"`, `"profesor"`) | Identificador del usuario. |
| `role` | String | `"guest"` o `"admin"` | Rol del usuario (ambos permiten reservar en esta demo). |

### 2.2 Operación Central: Reservar (Saga)
Ejecuta la transacción distribuida secuencial (Habitaciones -> Pagos -> Confirmación).

**Endpoint:** `POST http://localhost:8080/saga/reservar`
**Headers:** `Authorization: Bearer <TU_TOKEN>`

| Variable | Tipo | Dominio (Valores válidos) | Descripción |
| :--- | :--- | :--- | :--- |
| `roomId` | String | `"101"`, `"102"`, `"201"` | ID de la habitación a reservar. |
| `from` | String | Formato `YYYY-MM-DD` | Fecha de inicio de la reserva. |
| `to` | String | Formato `YYYY-MM-DD` (estrictamente mayor a `from`) | Fecha de fin de la reserva. |
| `amount` | Number | `> 0` (ej: `150`, `200`, `300`) | Monto del cobro de garantía. |
| `userId` | String | Cualquier cadena de texto | ID del usuario que realiza la reserva. |
| `simulatePayment` | String | `undefined` (omitir), `"slow"`, `"down"` | Simula fallas en la pasarela de Pagos. |
| `simulateConfirmation` | String | `undefined` (omitir), `"fail"` | Simula fallo en el servicio de Confirmación. |

---

## 3. Anatomía de los Comandos en PowerShell

Para ejecutar las pruebas, se utiliza el cmdlet `Invoke-RestMethod`. Es fundamental comprender qué significa cada uno de sus parámetros (los textos en azul) y cómo varían según el escenario.

La estructura general es:
```powershell
Invoke-RestMethod -Uri "<URL_DESTINO>" -Method <VERBO_HTTP> -ContentType "<FORMATO>" -Headers @{<CLAVE>="<VALOR>"} -Body "<JSON>" -TimeoutSec <SEGUNDOS>
```

| Parámetro | Propósito | Cómo varía (Dominio) |
| :--- | :--- | :--- |
| **`-Uri`** | Ruta exacta del endpoint. | Cambia según el servicio (ej. `"http://localhost:8080/saga/reservar"`, `"http://localhost:8080/saga/circuit"`). |
| **`-Method`** | Verbo HTTP de la acción. | **`Get`** para consultar (ej. estado del circuito) o **`Post`** para enviar datos y crear (ej. reservar). |
| **`-ContentType`** | Formato de los datos enviados. | Siempre **`"application/json"`** en este sistema, ya que usamos objetos JSON. |
| **`-Headers`** | Metadatos de autenticación. | Siempre **`@{Authorization="Bearer $TOKEN"}`**. El token debe ser el generado en el paso previo. |
| **`-Body`** | Carga útil (JSON). | Varía según lo que se quiera reservar (cambian fechas, montos, habitaciones). En PowerShell el JSON va entre comillas simples (`' '`) y las claves entre comillas dobles (`" "`). |
| **`-TimeoutSec`** | Límite de espera del cliente. | Entero positivo (ej. `5`, `10`). Útil para evitar que la consola se congele si simulamos lentitud extrema. |

---

## 4. Matriz de Casos de Negocio y Comportamiento del Sistema

El sistema está diseñado para reaccionar de forma determinista ante distintos escenarios durante el ciclo de vida de una reserva, garantizando que **nunca quede un descuadre** (ni cobro sin habitación, ni habitación sin cobro).

### Caso 1: Reserva Exitosa (Camino Feliz)
*   **Descripción:** El usuario reserva, paga y obtiene la confirmación sin problemas.
*   **Comportamiento:** La Saga completa los 3 pasos. La habitación queda `RESERVED`, el pago `CHARGED` y la confirmación `CONFIRMED`.

### Caso 2: Fallo en la Confirmación (Usuario paga, pero no hay voucher)
*   **Descripción:** El usuario reserva y paga, pero el sistema de confirmación falla.
*   **Comportamiento:** La Saga falla en el Paso 3. **Se ejecuta la compensación en orden inverso:** se reembolsa el dinero (Paso 2) y se libera la habitación (Paso 1). El sistema vuelve a su estado inicial.

### Caso 3: Fallo en el Pago (El usuario intenta pagar y es rechazado)
*   **Descripción:** El usuario reserva, pero la pasarela de pagos está caída o rechaza la tarjeta. Al no haber pago, no se puede emitir confirmación.
*   **Comportamiento:** La Saga falla en el Paso 2. Se ejecuta la compensación del único paso exitoso (Paso 1: Liberar habitación). El dinero nunca se cobra.

### Caso 4: Habitación No Disponible (Falla antes de empezar)
*   **Descripción:** El usuario intenta reservar una habitación en fechas que ya están ocupadas.
*   **Comportamiento:** El microservicio de Habitaciones rechaza la petición (Error 409). La Saga falla en el Paso 1. Como no hay pasos previos, no hay nada que compensar. No hay cobros ni reservas.

### Caso 5: Cancelación Voluntaria del Usuario y Reembolso (Extensión Propuesta)
*   **Descripción:** El usuario ya tiene una reserva exitosa, pero por motivos personales decide cancelar y solicitar su dinero de vuelta.
*   **Comportamiento Actual:** Por seguridad y consistencia transaccional, el sistema **no expone un endpoint público** para cancelar reservas exitosas desde el cliente, ya que un fallo de red a mitad de la cancelación podría dejar el sistema inconsistente.
*   **Solución Arquitectónica Propuesta:** Para implementar esta funcionalidad manteniendo la consistencia, se debe crear una **Saga de Cancelación**. Se expondría un endpoint `POST /saga/cancelar` que orqueste los pasos en orden inverso estricto:
    1.  Anular el voucher (Confirmación).
    2.  Reembolsar el dinero (Pagos).
    3.  Liberar la habitación (Habitaciones).
    *Nota de negocio:* Esta nueva funcionalidad requeriría definir reglas de negocio, como aplicar penalizaciones si el usuario cancela a menos de 24 horas del check-in.

---

## 5. Guía de Escenarios Técnicos y Troubleshooting

### Configuración Inicial (Obtención del Token)
Guarde el token en una variable para no repetirlo:
```powershell
$TOKEN = (Invoke-RestMethod -Uri "http://localhost:8080/auth/token" -Method Post -ContentType "application/json" -Body '{"user":"ana","role":"guest"}').token
```

### Escenario Técnico 1: Camino Feliz (Caso 1)
```powershell
$body = '{"roomId":"101","from":"2026-06-01","to":"2026-06-03","amount":150,"userId":"ana"}'
Invoke-RestMethod -Uri "http://localhost:8080/saga/reservar" -Method Post -ContentType "application/json" -Headers @{Authorization="Bearer $TOKEN"} -Body $body | ConvertTo-Json -Depth 10
```
*   **Resultado Esperado:** JSON con `"status": "COMPLETED"`.
*   **Troubleshooting:** Error 409 significa que la habitación ya está reservada en esas fechas. Ejecute `docker compose down -v` para limpiar el entorno y vuelva a intentar. Error 401 indica que el token expiró.

### Escenario Técnico 2: Fallo con Compensación (Caso 2)
```powershell
$body = '{"roomId":"102","from":"2026-06-10","to":"2026-06-12","amount":200,"userId":"ana","simulateConfirmation":"fail"}'
try { Invoke-RestMethod -Uri "http://localhost:8080/saga/reservar" -Method Post -ContentType "application/json" -Headers @{Authorization="Bearer $TOKEN"} -Body $body | ConvertTo-Json -Depth 10 } catch { $_.ErrorDetails.Message }
```
*   **Resultado Esperado:** HTTP 500. El cuerpo del error dirá `"status": "COMPENSATED"`. En la traza se ve el reembolso y la liberación.
*   **Troubleshooting:** Si la consola se queda colgada, revise los logs con `docker logs saga-orchestrator -f` para identificar si hay bloqueos en SQLite.

### Escenario Técnico 3: Resiliencia (Circuit Breaker y Bulkhead)

#### 3.1. Simulación de Caída del Servicio de Pagos (Caso 3)
```powershell
$body = '{"roomId":"201","from":"2026-07-01","to":"2026-07-03","amount":300,"userId":"ana","simulatePayment":"down"}'
try { Invoke-RestMethod -Uri "http://localhost:8080/saga/reservar" -Method Post -ContentType "application/json" -Headers @{Authorization="Bearer $TOKEN"} -Body $body } catch { Write-Host "Fallo esperado: Pagos caído" }
```
*(Ejecute este comando 4 veces consecutivas para abrir el circuito).*

**Verificación del Circuit Breaker:**
```powershell
Invoke-RestMethod -Uri "http://localhost:8080/saga/circuit" -Method Get -Headers @{Authorization="Bearer $TOKEN"} | ConvertTo-Json -Depth 5
```
*   **Resultado Esperado:** `"state": "OPEN"`. El circuito se abrió y ahora rechaza peticiones rápido (fail-fast).
*   **Troubleshooting:** El circuito se cierra automáticamente a los 8 segundos (pasa a HALF_OPEN). Si dice `"CLOSED"`, haga las peticiones de falla y consulte el estado de inmediato.

#### 3.2. Simulación de Lentitud y Saturación (Bulkhead)
```powershell
1..10 | ForEach-Object {
    Start-Job -ScriptBlock {
        param($t)
        try {
            $b = '{"roomId":"201","from":"2026-07-01","to":"2026-07-03","amount":300,"userId":"ana","simulatePayment":"slow"}'
            Invoke-RestMethod -Uri "http://localhost:8080/saga/reservar" -Method Post -ContentType "application/json" -Headers @{Authorization="Bearer $t"} -Body $b -TimeoutSec 5
        } catch {
            Write-Host "Rechazado por Bulkhead o CB abierto" -ForegroundColor Cyan
        }
    } -ArgumentList $TOKEN
} | Wait-Job | Receive-Job
```
*   **Resultado Esperado:** Se rechazan las peticiones excedentes. El sistema no se cae.
*   **Evidencia en Logs:** Ejecute `docker logs saga-orchestrator --tail 50` para ver los `[CB] REJECT (bulkhead)`.
*   **Troubleshooting:** Si el sistema operativo se queda sin memoria, el Bulkhead no está aislando bien; revise el archivo `circuit.js` y asegúrese de que `MAX_CONCURRENT = 3`.

---

## 6. Comandos de Diagnóstico Avanzado (Auditoría)

Si el docente desea comprobar que las transacciones se guardaron correctamente en las bases de datos, ejecute:

**Habitaciones (Verificar estado RESERVED o RELEASED):**
```powershell
docker exec -it habitaciones sqlite3 /data/habitaciones.db "SELECT * FROM reservations;"
```

**Pagos (Verificar estado CHARGED o REFUNDED):**
```powershell
docker exec -it pagos sqlite3 /data/pagos.db "SELECT * FROM payments;"
```

**Confirmaciones (Verificar estado CONFIRMED o inexistente):**
```powershell
docker exec -it confirmacion sqlite3 /data/confirmacion.db "SELECT * FROM confirmations;"
```

---

## 7. Diagrama de Arquitectura y Mapeo de Pruebas

```text
[ Cliente / PowerShell ]
       |
       | (1) POST /auth/token  --> [Obtiene JWT]
       v
+----------------+
|  API GATEWAY   | <--- Autenticación JWT y Rate Limiting
|  (Puerto 8080) |
+----------------+
       |
       | (2) POST /saga/reservar
       v
+-----------------------+       (3) GET /saga/circuit
|  SAGA ORCHESTRATOR    | <--------------------------+
|  (Puerto 3004)        |                            |
|                       |                            |
|  [Circuit Breaker]    | --(4)--> [ BFF (Puerto 8090) ]
|  [Bulkhead]           |          GET /bff/dashboard
+-----------------------+
       |
       |--- (Paso 1) ---> [ HABITACIONES (3001) ] ---> [SQLite]
       |                  POST /reservations
       |
       |--- (Paso 2) ---> [ PAGOS (3002) ] ----------> [SQLite]
       |                  POST /charges  <-- [Dependencia Frágil]
       |                                     (simulate=slow/down)
       |
       |--- (Paso 3) ---> [ CONFIRMACION (3003) ] ---> [SQLite]
                          POST /confirmations
```
