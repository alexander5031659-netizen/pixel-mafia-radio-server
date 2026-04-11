============================================================
PIXEL MAFIA RADIO SERVER - PARA RENDER
============================================================

ARCHIVOS INCLUIDOS:
- servidor.js      (Servidor de radio actualizado)
- package.json     (Dependencias necesarias)
- README.txt       (Este archivo)

============================================================
INSTRUCCIONES PARA DEPLOY EN RENDER
============================================================

OPCION 1: NUEVO SERVICIO EN RENDER
------------------------------------

1. Ve a https://dashboard.render.com

2. Click "New" → "Web Service"

3. Si usas GitHub:
   - Conecta tu repo
   - Selecciona la carpeta "render-server"
   
   Si subes manual:
   - Click "Upload" 
   - Selecciona todos los archivos de esta carpeta

4. Configuración:
   - Name: pixel-mafia-radio
   - Runtime: Node
   - Build Command: npm install
   - Start Command: node servidor.js
   - Plan: Free

5. Click "Create Web Service"

6. Espera 2-3 minutos a que termine el deploy

7. La URL será: https://[nombre-de-tu-servicio].onrender.com


OPCION 2: ACTUALIZAR SERVICIO EXISTENTE
----------------------------------------

1. Ve a https://dashboard.render.com

2. Busca tu servicio existente: pixel-mafia-radio

3. Click en "Manual Deploy" (botón azul arriba a la derecha)

4. Selecciona "Deploy Latest Commit" o "Upload Files"

5. Sube los archivos de esta carpeta (servidor.js, package.json)

6. Espera 2-3 minutos


============================================================
VERIFICAR QUE FUNCIONA
============================================================

Después del deploy, prueba estos URLs:

1. Health check:
   https://TU-SERVICIO.onrender.com/health
   
   Debe mostrar:
   {"status":"ok","message":"PixelMafia Radio Server Online"}

2. Configuración:
   https://TU-SERVICIO.onrender.com/config
   
   Debe mostrar la URL correcta (no localhost)

3. Buscar canción:
   https://TU-SERVICIO.onrender.com/play?q=bad+bunny&sala=123


============================================================
IMPORTANTE
============================================================

- Este servidor SOLO contiene el código de radio
- NO incluye el panel ni los bots (están en tu PC)
- El bot en tu PC se conecta a este servidor

URL para poner en el panel:
https://[tu-servicio].onrender.com

============================================================
