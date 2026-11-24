# Sistema Distribuido Resiliente: Gestión de Reservas Hoteleras (Forma H)

## 1. Introducción y arquitectura del sistema

Este proyecto implementa un sistema distribuido para la gestión de reservas hoteleras. Su objetivo es coordinar la reserva de una habitación, el cobro de una garantía y la emisión de una confirmación mediante servicios independientes.

La arquitectura utiliza los siguientes componentes:

- **API Gateway (puerto 8080):** único punto de entrada externo. Centraliza la autenticación mediante JWT, aplica Rate Limiting y enruta las solicitudes.
- **BFF (Backend For Frontend):** agrega información de múltiples microservicios en una respuesta orientada al cliente.
- **Saga Orchestrator (puerto 3004):** coordina la transacción distribuida y ejecuta las compensaciones cuando corresponde.
- **Microservicio de Habitaciones (puerto 3001):** administra la disponibilidad y las reservas.
- **Microservicio de Pagos (puerto 3002):** administra los cobros y reembolsos.
- **Microservicio de Confirmación (puerto 3003):** emite y administra las confirmaciones de reserva.

Cada servicio de dominio mantiene su propia base de datos SQLite. Los componentes se comunican mediante HTTP/JSON y se despliegan utilizando Docker Compose.

La solución incorpora los siguientes mecanismos de resiliencia sobre la dependencia de Pagos:

- Timeout de 1200 ms en la llamada protegida.
- Circuit Breaker mediante Opossum.
- Bulkhead con un máximo configurado de tres llamadas concurrentes.
- Fallback ante fallos de la dependencia.

**Consideración sobre consistencia:** la Saga intenta recuperar el estado anterior mediante compensaciones, pero estas no garantizan consistencia global absoluta. Un timeout no implica necesariamente que una operación remota haya sido cancelada. Por este motivo, se debe considerar la posibilidad de operaciones de pago tardías y la necesidad de reconciliación.

### Despliegue del sistema

Desde la raíz del proyecto, ejecutar:

```bash
docker compose up --build
```

Para detener los contenedores y eliminar los volúmenes asociados, incluidas las bases de datos persistentes:

```bash
docker compose down -v
```

Para iniciar nuevamente el entorno:

```bash
docker compose up --build
```

**Advertencia:** `docker compose down -v` elimina los datos persistidos en los volúmenes. No utilizarlo si se desea conservar el historial de reservas, pagos y confirmaciones.

---

## 2. Variables y endpoints principales

### 2.1. Autenticación mediante Gateway

El Gateway requiere un token JWT para autorizar las solicitudes protegidas.

**Endpoint:**

`POST http://localhost:8080/auth/token`

**Cuerpo JSON:**

```json
{
  "user": "ana",
  "role": "guest"
}
```

| Variable | Tipo | Valores | Descripción |
|---|---|---|---|
| `user` | String | Cualquier cadena de texto | Identificador del usuario. |
| `role` | String | `guest` o `admin` | Rol utilizado en la autenticación de esta demostración. |

Ambos roles permiten realizar reservas en la configuración de demostración.

### 2.2. Operación principal: reservar

La operación central ejecuta la Saga en el siguiente orden:

1. Reservar habitación.
2. Cobrar garantía.
3. Emitir confirmación.

**Endpoint:**

`POST http://localhost:8080/saga/reservar`

**Encabezado requerido:**

```http
Authorization: Bearer <TU_TOKEN>
```

**Variables del cuerpo JSON:**

| Variable | Tipo | Valores o formato | Descripción |
|---|---|---|---|
| `roomId` | String | Ej. `"101"`, `"102"`, `"201"` | Identificador de la habitación. |
| `from` | String | `YYYY-MM-DD` | Fecha de inicio. |
| `to` | String | `YYYY-MM-DD`, posterior a `from` | Fecha de término. |
| `amount` | Number | Mayor que 0 | Monto de la garantía. |
| `userId` | String | Cualquier cadena | Identificador del usuario. |
| `simulatePayment` | String | Omitir, `"slow"` o `"down"` | Simula lentitud o caída de Pagos. |
| `simulateConfirmation` | String | Omitir o `"fail"` | Simula un fallo en Confirmación. |

Los campos `simulatePayment` y `simulateConfirmation` se utilizan exclusivamente para las pruebas de resiliencia.

### 2.3. Consulta del Circuit Breaker

**Endpoint:**

`GET http://localhost:8080/saga/circuit`

Permite consultar el estado y las estadísticas del Circuit Breaker, incluyendo fallos, rechazos, solicitudes y latencia registrada.

Los estados posibles son:

- `CLOSED`: permite las llamadas normalmente.
- `OPEN`: rechaza nuevas llamadas a la dependencia protegida.
- `HALF_OPEN`: permite llamadas de prueba para comprobar si la dependencia se recuperó.

---

## 3. Ejecución de solicitudes desde PowerShell

Las pruebas pueden realizarse mediante el cmdlet `Invoke-RestMethod`.

Su estructura general es:

```powershell
Invoke-RestMethod `
    -Uri "<URL_DESTINO>" `
    -Method <VERBO_HTTP> `
    -ContentType "application/json" `
    -Headers @{ Authorization = "Bearer $TOKEN" } `
    -Body '<JSON>' `
    -TimeoutSec <SEGUNDOS>
```

| Parámetro | Propósito |
|---|---|
| `-Uri` | Dirección del endpoint. |
| `-Method` | Verbo HTTP, normalmente `Get` o `Post`. |
| `-ContentType` | Formato de los datos enviados. En este sistema se utiliza JSON. |
| `-Headers` | Encabezados HTTP, incluyendo el token JWT. |
| `-Body` | Contenido JSON de la solicitud. |
| `-TimeoutSec` | Tiempo máximo de espera del cliente PowerShell. |

El parámetro `-TimeoutSec` controla la espera del cliente y es independiente del timeout configurado en la llamada protegida del servicio de Pagos.

---

## 4. Matriz de casos de negocio

La Saga coordina las operaciones y, cuando detecta un fallo, intenta ejecutar las compensaciones correspondientes. Esto permite recuperar el estado anterior en los escenarios controlados, aunque no garantiza que todas las operaciones remotas hayan dejado de ejecutarse.

### Caso 1: reserva exitosa

**Descripción:** el usuario reserva una habitación, paga la garantía y recibe una confirmación.

**Comportamiento esperado:**

1. Habitaciones registra la reserva.
2. Pagos registra el cobro.
3. Confirmación emite el voucher.

La Saga termina con estado `COMPLETED`.

Los estados esperados en las bases son:

| Servicio | Estado |
|---|---|
| Habitaciones | `RESERVED` |
| Pagos | `CHARGED` |
| Confirmación | `CONFIRMED` |

### Caso 2: fallo en Confirmación

**Descripción:** la habitación fue reservada y la garantía cobrada, pero el servicio de Confirmación falla.

**Comportamiento esperado:**

La Saga ejecuta las compensaciones en orden inverso:

1. Reembolsar el pago.
2. Liberar la habitación.

El resultado observado en la prueba fue `COMPENSATED`, con ambas compensaciones ejecutadas correctamente.

Los estados resultantes fueron:

| Servicio | Estado |
|---|---|
| Habitaciones | `RELEASED` |
| Pagos | `REFUNDED` |
| Confirmación | Sin registro para la reserva fallida |

### Caso 3: fallo en Pagos

**Descripción:** el usuario inicia una reserva, pero el servicio de Pagos falla o no responde dentro del tiempo esperado.

**Comportamiento esperado:**

La Saga considera fallida la operación de cobro e intenta liberar la habitación, ya que no puede continuar con la confirmación.

Sin embargo, existe una consideración importante: si el orquestador agota su timeout mientras Pagos continúa procesando la solicitud, el servicio remoto podría registrar el cobro posteriormente.

Por lo tanto, no se garantiza que toda solicitud de pago fallida desde el punto de vista del orquestador implique necesariamente que no hubo cobro. Los resultados inciertos deben verificarse y reconciliarse.

### Caso 4: habitación no disponible

**Descripción:** el usuario intenta reservar una habitación que ya está ocupada durante el intervalo solicitado.

**Comportamiento esperado:**

El servicio de Habitaciones rechaza la solicitud. En caso de que la implementación devuelva HTTP 409, la Saga termina sin ejecutar los pasos de Pagos ni Confirmación.

Como no existen pasos anteriores completados, no hay compensaciones que ejecutar.

### Caso 5: cancelación voluntaria

**Descripción:** un usuario desea cancelar una reserva que ya fue completada y solicitar un reembolso.

**Comportamiento actual:**

El sistema no expone un endpoint público para cancelar reservas exitosas desde el cliente. Esta funcionalidad no forma parte del flujo implementado.

**Extensión propuesta: Saga de Cancelación**

Para incorporar esta operación se podría implementar un endpoint `POST /saga/cancelar`, coordinando:

1. Anular la confirmación.
2. Reembolsar el pago.
3. Liberar la habitación.

Esta funcionalidad requeriría definir reglas de negocio adicionales, como penalizaciones por cancelación tardía y condiciones de reembolso.

---

## 5. Guía de pruebas técnicas

### Configuración inicial: obtención del token

Ejecutar el siguiente comando para obtener y guardar el token:

```powershell
$TOKEN = (
    Invoke-RestMethod `
        -Uri "http://localhost:8080/auth/token" `
        -Method Post `
        -ContentType "application/json" `
        -Body '{"user":"ana","role":"guest"}'
).token
```

### Escenario 1: camino feliz

```powershell
$body = '{
    "roomId":"101",
    "from":"2026-06-01",
    "to":"2026-06-03",
    "amount":150,
    "userId":"ana"
}'

Invoke-RestMethod `
    -Uri "http://localhost:8080/saga/reservar" `
    -Method Post `
    -ContentType "application/json" `
    -Headers @{ Authorization = "Bearer $TOKEN" } `
    -Body $body |
    ConvertTo-Json -Depth 10
```

**Resultado esperado:** respuesta con estado `COMPLETED`, identificadores de reserva, pago y confirmación, además del voucher generado.

**Diagnóstico:**

- HTTP 409: la habitación no está disponible para las fechas solicitadas.
- HTTP 401: el token no es válido o expiró.
- Error de conexión: verificar que los contenedores estén activos.

### Escenario 2: fallo en Confirmación y compensación

```powershell
$body = '{
    "roomId":"102",
    "from":"2026-06-10",
    "to":"2026-06-12",
    "amount":200,
    "userId":"ana",
    "simulateConfirmation":"fail"
}'

try {
    Invoke-RestMethod `
        -Uri "http://localhost:8080/saga/reservar" `
        -Method Post `
        -ContentType "application/json" `
        -Headers @{ Authorization = "Bearer $TOKEN" } `
        -Body $body |
        ConvertTo-Json -Depth 10
}
catch {
    $_.ErrorDetails.Message
}
```

**Resultado observado:** HTTP 500 y estado de Saga `COMPENSATED`.

En la traza deben aparecer las operaciones de reembolso y liberación de habitación.

Para revisar los registros:

```powershell
docker logs saga-orchestrator --tail 50
```

### Escenario 3: Circuit Breaker ante caída de Pagos

Se utiliza `simulatePayment: "down"` para provocar fallos en la dependencia.

```powershell
$body = '{
    "roomId":"201",
    "from":"2026-07-01",
    "to":"2026-07-03",
    "amount":300,
    "userId":"ana",
    "simulatePayment":"down"
}'

1..4 | ForEach-Object {
    try {
        Invoke-RestMethod `
            -Uri "http://localhost:8080/saga/reservar" `
            -Method Post `
            -ContentType "application/json" `
            -Headers @{ Authorization = "Bearer $TOKEN" } `
            -Body $body
    }
    catch {
        Write-Host "Fallo esperado durante la prueba."
    }
}
```

Las cuatro solicitudes se utilizan para reproducir la apertura del circuito observada durante las pruebas. Antes de repetirlas, verificar que el estado del circuito permita ejecutar nuevamente el escenario.

**Consulta del estado:**

```powershell
Invoke-RestMethod `
    -Uri "http://localhost:8080/saga/circuit" `
    -Method Get `
    -Headers @{ Authorization = "Bearer $TOKEN" } |
    ConvertTo-Json -Depth 5
```

**Resultado observado:** el circuito alcanzó el estado `OPEN`, con tres fallos registrados y un rechazo posterior.

En esta prueba, los fallos simulados respondieron rápidamente; la latencia media registrada fue aproximadamente 3 ms. No debe interpretarse este valor como una medición de tiempo ahorrado frente a una ejecución sin Circuit Breaker.

Para observar la recuperación, consultar nuevamente el endpoint y realizar una operación normal cuando el circuito permita la prueba en estado `HALF_OPEN`. Una respuesta exitosa permite que el circuito vuelva a `CLOSED`.

### Escenario 4: lentitud y saturación mediante Bulkhead

Se utiliza `simulatePayment: "slow"` para simular operaciones de pago lentas.

La prueba consiste en enviar diez solicitudes concurrentes. Para evitar que los conflictos de disponibilidad interfieran con la prueba, se deben utilizar intervalos que no entren en conflicto con reservas existentes.

Ejemplo de ejecución:

```powershell
$jobs = 1..10 | ForEach-Object {
    Start-Job -ScriptBlock {
        param($token, $index)

        $start = (Get-Date "2026-07-01").AddDays($index * 3)
        $end = $start.AddDays(2)

        $body = @{
            roomId = "201"
            from = $start.ToString("yyyy-MM-dd")
            to = $end.ToString("yyyy-MM-dd")
            amount = 300
            userId = "ana"
            simulatePayment = "slow"
        } | ConvertTo-Json -Compress

        try {
            Invoke-RestMethod `
                -Uri "http://localhost:8080/saga/reservar" `
                -Method Post `
                -ContentType "application/json" `
                -Headers @{ Authorization = "Bearer $token" } `
                -Body $body `
                -TimeoutSec 15
        }
        catch {
            Write-Host "Solicitud fallida: $($_.Exception.Message)"
        }
    } -ArgumentList $TOKEN, $_
}

$jobs | Wait-Job | Receive-Job
$jobs | Remove-Job
```

**Resultado esperado:** algunas llamadas pueden ser rechazadas por el Bulkhead o por el Circuit Breaker, dependiendo del estado de la dependencia y de la concurrencia alcanzada.

**Evidencia en los logs:**

```powershell
docker logs saga-orchestrator --tail 100
```

Buscar mensajes como:

```text
[CB] REJECT (bulkhead)
```

Estos mensajes constituyen evidencia directa de que el Bulkhead rechazó solicitudes al alcanzarse el límite de concurrencia.

No todos los errores de la prueba deben atribuirse al Bulkhead: también pueden aparecer fallos por timeout, fallback o apertura del Circuit Breaker.

La prueba demuestra rechazos de solicitudes por saturación de la dependencia. Para afirmar que los demás servicios mantuvieron su disponibilidad durante el pico sería necesario medirlos de forma independiente.

---

## 6. Consultas de diagnóstico y auditoría

Cada servicio mantiene su propia base SQLite. Las siguientes consultas permiten inspeccionar los registros persistidos.

### Habitaciones

```powershell
docker exec -it habitaciones sqlite3 -header -column /data/habitaciones.db "SELECT * FROM reservations;"
```

Permite revisar las reservas y sus estados, como `RESERVED` y `RELEASED`.

### Pagos

```powershell
docker exec -it pagos sqlite3 -header -column /data/pagos.db "SELECT id, reservation_ref, amount, status FROM payments ORDER BY created_at;"
```

Permite revisar los cobros y reembolsos registrados.

### Confirmaciones

```powershell
docker exec -it confirmacion sqlite3 -header -column /data/confirmacion.db "SELECT * FROM confirmations;"
```

Permite revisar las confirmaciones emitidas.

### Interpretación de los resultados

Los estados esperados en una operación exitosa son:

| Habitaciones | Pagos | Confirmación | Interpretación |
|---|---|---|---|
| `RESERVED` | `CHARGED` | `CONFIRMED` | Operación completada. |

Después de una compensación completa por fallo en Confirmación:

| Habitaciones | Pagos | Confirmación | Interpretación |
|---|---|---|---|
| `RELEASED` | `REFUNDED` | Sin registro | Compensación ejecutada. |

Durante la auditoría de las pruebas también se identificaron ocho registros `CHARGED` asociados aparentemente a reservas `RELEASED`.

Este resultado evidencia una posible inconsistencia entre los servicios. Una explicación compatible con los datos es que Pagos haya terminado de procesar una solicitud después de que el orquestador agotara su timeout e iniciara la compensación.

Los registros disponibles no permiten confirmar el orden temporal exacto de todos esos casos. Por ello, se considera una limitación detectada y un aspecto pendiente de reconciliación, no una causa demostrada.

---

## 7. Diagrama de arquitectura y flujo de solicitudes

```text
                 [ Cliente / PowerShell ]
                          |
                          | POST /auth/token
                          | Obtención de JWT
                          v
                 +--------------------+
                 |    API GATEWAY     |
                 |    Puerto 8080     |
                 |                    |
                 | - Autenticación    |
                 | - Rate Limiting    |
                 | - Enrutamiento     |
                 +--------------------+
                     |           |
       /saga/reservar|           |Rutas de agregación
                     v           v
           +----------------+  +----------------+
           | SAGA           |  | BFF            |
           | ORCHESTRATOR   |  | Agregación     |
           | Puerto 3004    |  | de información|
           +----------------+  +----------------+
                  |
                  | Coordinación de la Saga
                  |
       +----------+-----------+
       |          |           |
       v          v           v
+-------------+ +---------+ +----------------+
| HABITACIONES| | PAGOS   | | CONFIRMACION   |
| Puerto 3001 | | Puerto  | | Puerto 3003    |
|             | | 3002    | |                |
| SQLite      | | SQLite  | | SQLite         |
+-------------+ +---------+ +----------------+
                    |
             [Dependencia frágil]
                    |
          +-----------------------+
          | Circuit Breaker       |
          | Bulkhead               |
          | Timeout                |
          | Fallback               |
          +-----------------------+
```

El Gateway enruta las solicitudes externas hacia el componente correspondiente. La operación de reserva llega al Saga Orchestrator, que coordina directamente los tres servicios de dominio. El BFF tiene una responsabilidad distinta: agregar información de los servicios para entregarla al cliente.

El puerto del BFF y la ruta exacta de agregación deben consultarse en la configuración del despliegue y en sus rutas implementadas.

---

## 8. Limitaciones y trabajo futuro

Las pruebas permitieron comprobar el camino feliz, la compensación ante un fallo en Confirmación, la apertura y recuperación del Circuit Breaker y los rechazos explícitos del Bulkhead.

Sin embargo, se identificaron aspectos que requieren trabajo adicional:

1. **Idempotencia:** aunque existen mecanismos de identificación de operaciones en la persistencia, las compensaciones observadas informaron `idempotent: false`. Por lo tanto, no se considera demostrada la idempotencia completa de las operaciones.
2. **Consistencia financiera:** se observaron registros de pagos cobrados asociados a reservas liberadas. Se requiere reconciliar operaciones de resultado incierto.
3. **Timeouts:** se verificó la configuración de timeout en la dependencia de Pagos. No se afirma que todas las comunicaciones entre servicios tengan una política independiente equivalente.
4. **Disponibilidad durante saturación:** se observaron rechazos del Bulkhead, pero no se realizó una medición independiente de disponibilidad de todos los demás componentes durante la prueba concurrente.
5. **Cancelación voluntaria:** se propone como extensión una Saga específica para cancelar reservas completadas y gestionar sus reembolsos.

Estas limitaciones permiten distinguir entre los mecanismos implementados, los resultados observados y las propiedades que todavía requieren validación.

---

## 9. Referencias

- Opossum. *Node.js Circuit Breaker*. https://nodeshift.dev/opossum/
- Microservices.io. *Saga Pattern*. https://microservices.io/patterns/data/saga.html
- Microservices.io. *API Gateway Pattern*. https://microservices.io/patterns/apigateway.html
- Newman, S. *Building Microservices*. O'Reilly, 2021.
- Richardson, C. *Microservices Patterns*. Manning, 2018.