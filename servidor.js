// servidor.js - Radio continua con colas por sala
const express = require('express');
const { spawn, spawnSync } = require('child_process');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

// Sistema de colas por sala con buffer compartido
const salas = new Map(); // salaId -> { cola, cancionActual, reproduciendo, clientes, buffer, bufferIndex, procesos }

function getSala(salaId) {
    if(!salas.has(salaId)){
        salas.set(salaId, {
            cola: [],
            cancionActual: null,
            reproduciendo: false,
            clientes: [],
            buffer: [], // Buffer circular para sincronización
            bufferIndex: 0,
            bufferSize: 150, // Aumentado a 150 chunks para mejor sincronización móvil
            procesos: { ytdlp: null, ffmpeg: null } // Procesos activos
        });
    }
    return salas.get(salaId);
}

// Buscar info de la cancion con yt-dlp
function buscarYoutube(query) {
  try {
    const esUrl = String(query).startsWith('http');
    const arg = esUrl ? query : `ytsearch1:${query}`;
    
    const out = spawnSync('python', ['-m', 'yt_dlp', arg, '--print', '%(title)s|||%(duration)s|||%(webpage_url)s', '--no-playlist', '--quiet'], { 
      encoding: 'utf8', 
      timeout: 30000,
      windowsHide: true
    });
    
    if (out.error || out.status !== 0) return null;
    
    const stdout = out.stdout.toString().trim();
    if(!stdout) return null;
    
    const partes = stdout.split('|||');
    if (partes.length < 3) return null;
    
    let titulo = partes[0].trim();
    const duracion = parseInt(partes[1].trim()) || 0;
    const url = partes[2].trim();
    
    // Limpiar título
    titulo = titulo.replace(/[\u{1F600}-\u{1F64F}]/gu, '');
    titulo = titulo.replace(/[\u{1F300}-\u{1F5FF}]/gu, '');
    titulo = titulo.replace(/[\u{1F680}-\u{1F6FF}]/gu, '');
    titulo = titulo.replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '');
    titulo = titulo.replace(/[\u{2600}-\u{26FF}]/gu, '');
    titulo = titulo.replace(/[\u{2700}-\u{27BF}]/gu, '');
    titulo = titulo.replace(/\(Official.*?\)/gi, '');
    titulo = titulo.replace(/\[Official.*?\]/gi, '');
    titulo = titulo.replace(/\s+/g, ' ').trim();
    
    if(titulo.length > 80){
      titulo = titulo.slice(0, 77) + '...';
    }
    
    return { titulo, duracion, url };
  } catch (e) {
    console.error('❌ Error buscando:', e.message);
    return null;
  }
}

// Reproducir siguiente canción de la cola de una sala
async function reproducirSiguiente(salaId) {
    const sala = getSala(salaId);
    
    console.log(`\n[${salaId}] 🔄 reproducirSiguiente() llamado`);
    console.log(`[${salaId}]    - Reproduciendo:`, sala.reproduciendo);
    console.log(`[${salaId}]    - Canción actual:`, sala.cancionActual ? sala.cancionActual.titulo : 'Ninguna');
    console.log(`[${salaId}]    - Cola length:`, sala.cola.length);
    console.log(`[${salaId}]    - Canciones en cola:`, sala.cola.map(c => c.titulo));
    console.log(`[${salaId}]    - Clientes conectados:`, sala.clientes.length);
    
    if(sala.reproduciendo) {
        console.log(`[${salaId}] ⏸️ Ya está reproduciendo, esperando...`);
        return;
    }
    
    // Si no hay canciones en cola, no hacer nada
    if(sala.cola.length === 0) {
        console.log(`[${salaId}] 📭 Cola vacía - Esperando canciones...`);
        return;
    }
    
    // Esperar a que haya al menos un cliente conectado antes de empezar
    if(sala.clientes.length === 0) {
        console.log(`[${salaId}] ⏳ Esperando que se conecte un cliente antes de reproducir...`);
        setTimeout(() => reproducirSiguiente(salaId), 2000);
        return;
    }
    
    // Hay canciones en la cola y clientes conectados, reproducir
    sala.reproduciendo = true;
    sala.cancionActual = sala.cola.shift();
    
    console.log(`[${salaId}] ▶️ Reproduciendo:`, sala.cancionActual.titulo);
    console.log(`[${salaId}] 📋 Quedan ${sala.cola.length} en cola`);
    console.log(`[${salaId}] 👥 Clientes conectados: ${sala.clientes.length}`);
    
    try {
        await streamCancion(sala.cancionActual, sala);
    } catch(e) {
        console.error(`[${salaId}] ❌ Error reproduciendo:`, e.message);
    }
    
    sala.reproduciendo = false;
    
    console.log(`[${salaId}] ✅ Canción terminada:`, sala.cancionActual.titulo);
    sala.cancionActual = null;
    
    // Reproducir siguiente automáticamente solo si hay más en la cola
    if(sala.cola.length > 0){
        console.log(`[${salaId}] 🔄 Hay más canciones, reproduciendo siguiente...`);
        setTimeout(() => reproducirSiguiente(salaId), 1000);
    } else {
        console.log(`[${salaId}] 📭 No hay más canciones en cola, esperando...`);
    }
}

// Stream de una canción con buffer compartido para sincronización
function streamCancion(cancion, sala) {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn('python', [
      '-m', 'yt_dlp',
      '-f', 'bestaudio',
      '-o', '-',
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      cancion.url
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-f', 'mp3',
      '-b:a', '128k',
      'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    // Guardar referencias a los procesos
    sala.procesos.ytdlp = ytdlp;
    sala.procesos.ffmpeg = ffmpeg;

    let bytesEnviados = 0;
    let streamTerminado = false;

    ytdlp.stdout.pipe(ffmpeg.stdin);

    ffmpeg.stdout.on('data', (chunk) => {
      // Verificar si debemos detener
      if(!sala.reproduciendo){
        ytdlp.kill('SIGKILL');
        ffmpeg.kill('SIGKILL');
        return;
      }
      
      bytesEnviados += chunk.length;
      
      // Agregar chunk al buffer circular
      sala.buffer.push(chunk);
      if(sala.buffer.length > sala.bufferSize){
        sala.buffer.shift(); // Eliminar el más viejo
      }
      sala.bufferIndex++;
      
      // Broadcast a todos los clientes conectados (si hay)
      if(sala.clientes.length > 0){
        sala.clientes.forEach(cliente => {
          try {
            if(cliente.writable){
              cliente.write(chunk);
            }
          } catch(e) {
            // Cliente desconectado
          }
        });
      }
      // Si no hay clientes, igual procesamos el stream para que la canción "suene"
    });

    ffmpeg.stdout.on('end', () => {
      if(!streamTerminado) {
        streamTerminado = true;
        // Limpiar buffer al terminar canción
        sala.buffer = [];
        sala.bufferIndex = 0;
        sala.procesos.ytdlp = null;
        sala.procesos.ffmpeg = null;
        resolve();
      }
    });

    ytdlp.on('error', (err) => {
      if(!streamTerminado) {
        streamTerminado = true;
        sala.procesos.ytdlp = null;
        sala.procesos.ffmpeg = null;
        reject(err);
      }
    });

    ffmpeg.on('error', (err) => {
      if(!streamTerminado) {
        streamTerminado = true;
        sala.procesos.ytdlp = null;
        sala.procesos.ffmpeg = null;
        reject(err);
      }
    });

    ffmpeg.on('close', (code) => {
      if(!streamTerminado) {
        streamTerminado = true;
        sala.procesos.ytdlp = null;
        sala.procesos.ffmpeg = null;
        if(code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg cerrado con código ${code}`));
        }
      }
    });
  });
}

// Endpoint de radio por sala con sincronización
app.get('/radio/:salaId', (req, res) => {
  const salaId = req.params.salaId;
  const sala = getSala(salaId);
  
  console.log(`[${salaId}] 📻 PixelMafia Radio - Nuevo cliente conectado`);
  console.log(`[${salaId}] 📱 User-Agent: ${req.headers['user-agent']?.substring(0, 50) || 'Unknown'}`);
  
  // Headers para compatibilidad con IMVU, móvil y navegadores
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('icy-name', 'PixelMafia Radio');
  res.setHeader('icy-description', 'La mejor música 24/7');
  res.setHeader('icy-genre', 'Various');
  res.setHeader('icy-url', 'https://pixelmafia.radio');
  res.setHeader('icy-br', '128');
  res.setHeader('icy-pub', '1');
  res.setHeader('icy-metaint', '16000');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

  // Enviar buffer existente INMEDIATAMENTE para sincronización
  if(sala.buffer.length > 0){
    console.log(`[${salaId}] 🔄 Sincronizando nuevo cliente con buffer (${sala.buffer.length} chunks)`);
    // Enviar los últimos 20 chunks para sincronización rápida
    const chunksParaSincronizar = Math.min(20, sala.buffer.length);
    const startIndex = sala.buffer.length - chunksParaSincronizar;
    
    for(let i = startIndex; i < sala.buffer.length; i++){
      try {
        if(!res.write(sala.buffer[i])){
          // Si el buffer está lleno, esperar un poco
          console.log(`[${salaId}] ⚠️ Buffer lleno, esperando...`);
          break;
        }
      } catch(e) {
        console.log(`[${salaId}] ⚠️ Error enviando buffer inicial:`, e.message);
        break;
      }
    }
    console.log(`[${salaId}] ✅ Buffer inicial enviado (${chunksParaSincronizar} chunks)`);
  } else {
    console.log(`[${salaId}] ℹ️ No hay buffer disponible, cliente esperará stream en vivo`);
  }

  sala.clientes.push(res);
  console.log(`[${salaId}] 👥 Total clientes: ${sala.clientes.length}`);
  
  // Si es el primer cliente y hay canciones en cola, iniciar reproducción INMEDIATAMENTE
  if(sala.clientes.length === 1 && !sala.reproduciendo && !sala.cancionActual && sala.cola.length > 0){
    console.log(`[${salaId}] 🎬 Primer cliente conectado, iniciando reproducción AHORA...`);
    setTimeout(() => reproducirSiguiente(salaId), 500);
  }
  
  res.on('close', () => {
    console.log(`[${salaId}] 📻 Cliente desconectado`);
    const index = sala.clientes.indexOf(res);
    if(index > -1) {
      sala.clientes.splice(index, 1);
    }
    console.log(`[${salaId}] 👥 Total clientes: ${sala.clientes.length}`);
  });
  
  res.on('error', (err) => {
    console.log(`[${salaId}] ⚠️ Error en cliente:`, err.message);
  });
  
  // Keep-alive para mantener la conexión activa en móvil
  const keepAliveInterval = setInterval(() => {
    if(res.writable){
      // Enviar un chunk vacío para mantener la conexión
      try {
        res.write(Buffer.alloc(0));
      } catch(e) {
        clearInterval(keepAliveInterval);
      }
    } else {
      clearInterval(keepAliveInterval);
    }
  }, 30000); // Cada 30 segundos
  
  res.on('close', () => {
    clearInterval(keepAliveInterval);
  });
});

// Agregar canción a la cola de una sala
app.get('/play', (req, res) => {
  const query = req.query.q || req.query.url;
  const salaId = req.query.sala || 'sala1';
  
  console.log(`\n[SERVIDOR] 📥 Request /play recibido`);
  console.log(`[SERVIDOR]    Query: ${query}`);
  console.log(`[SERVIDOR]    Sala: ${salaId}`);
  
  if (!query) return res.status(400).json({ error: 'Falta parametro q o url' });

  const info = buscarYoutube(query);
  if (!info) {
    return res.status(500).json({ error: 'No encontré la canción' });
  }

  const sala = getSala(salaId);
  sala.cola.push(info);
  
  console.log(`[${salaId}] ✅ Agregada a cola (posición ${sala.cola.length}):`, info.titulo);
  console.log(`[${salaId}] 📊 Estado actual:`);
  console.log(`[${salaId}]    - Reproduciendo:`, sala.reproduciendo);
  console.log(`[${salaId}]    - Canción actual:`, sala.cancionActual ? sala.cancionActual.titulo : 'Ninguna');
  console.log(`[${salaId}]    - Total en cola:`, sala.cola.length);

  // Detectar URL base automáticamente (soporta Render, Cloudflare, localhost)
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['host'] || req.get('host') || `localhost:${PORT}`;
  const HOST = `${protocol}://${host}`.replace(/\/$/, '');
  
  console.log(`[${salaId}] 🌐 URL base detectada: ${HOST}`);
  
  console.log(`[${salaId}] 🌐 HOST final para respuesta:`, HOST);

  // NO iniciar reproducción automáticamente
  // Esperará a que se conecte un cliente
  console.log(`[${salaId}] 📋 Canción agregada a cola. Esperando cliente para iniciar...`);

  res.json({
    titulo: info.titulo,
    duracion: info.duracion,
    posicion: sala.cancionActual ? sala.cola.length + 1 : 1,
    radioUrl: `${HOST}/radio/${salaId}`
  });
});

// Info de la canción actual y cola de una sala
// Health check endpoint para Render
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'PixelMafia Radio Server Online',
    timestamp: new Date().toISOString(),
    version: '2.0'
  });
});

// Endpoint para obtener la URL base del servidor
app.get('/config', (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['host'] || req.get('host');
  const baseUrl = `${protocol}://${host}`;
  
  res.json({
    baseUrl: baseUrl,
    radioPath: '/radio/:salaId',
    fullExample: `${baseUrl}/radio/sala1`
  });
});

app.get('/now', (req, res) => {
  const salaId = req.query.sala || 'sala1';
  const sala = getSala(salaId);
  
  res.json({
    actual: sala.cancionActual,
    cola: sala.cola.map(c => c.titulo),
    totalCola: sala.cola.length
  });
});

// Ver cola completa de una sala
app.get('/queue', (req, res) => {
  const salaId = req.query.sala || 'sala1';
  const sala = getSala(salaId);
  
  res.json({
    actual: sala.cancionActual ? sala.cancionActual.titulo : 'Nada',
    cola: sala.cola.map((c, i) => `${i+1}. ${c.titulo}`),
    total: sala.cola.length
  });
});

// Saltar canción actual de una sala
app.get('/skip', (req, res) => {
  const salaId = req.query.sala || 'sala1';
  const sala = getSala(salaId);
  
  console.log(`\n[${salaId}] 📥 Request /skip recibido`);
  console.log(`[${salaId}]    Canción actual:`, sala.cancionActual ? sala.cancionActual.titulo : 'Ninguna');
  console.log(`[${salaId}]    Reproduciendo:`, sala.reproduciendo);
  console.log(`[${salaId}]    Cola:`, sala.cola.length);
  
  if(sala.cancionActual) {
    console.log(`[${salaId}] ⏭️ Saltando:`, sala.cancionActual.titulo);
    
    // Matar procesos activos
    if(sala.procesos.ytdlp){
      try { 
        sala.procesos.ytdlp.kill('SIGKILL');
        console.log(`[${salaId}] 🔪 Proceso ytdlp matado`);
      } catch(e) {
        console.log(`[${salaId}] ⚠️ Error matando ytdlp:`, e.message);
      }
    }
    if(sala.procesos.ffmpeg){
      try { 
        sala.procesos.ffmpeg.kill('SIGKILL');
        console.log(`[${salaId}] 🔪 Proceso ffmpeg matado`);
      } catch(e) {
        console.log(`[${salaId}] ⚠️ Error matando ffmpeg:`, e.message);
      }
    }
    
    sala.reproduciendo = false;
    sala.cancionActual = null;
    sala.buffer = [];
    sala.bufferIndex = 0;
    
    console.log(`[${salaId}] 🔄 Estado limpiado, iniciando siguiente en 500ms...`);
    setTimeout(() => reproducirSiguiente(salaId), 500);
    res.json({ ok: true, mensaje: 'Canción saltada' });
  } else {
    console.log(`[${salaId}] ⚠️ No hay canción para saltar`);
    res.json({ ok: false, mensaje: 'No hay canción reproduciéndose' });
  }
});

// Limpiar cola de una sala
app.get('/clear', (req, res) => {
  const salaId = req.query.sala || 'sala1';
  const sala = getSala(salaId);
  
  const cantidad = sala.cola.length;
  sala.cola.length = 0;
  console.log(`[${salaId}] 🗑️ Cola limpiada (${cantidad} canciones)`);
  res.json({ ok: true, eliminadas: cantidad });
});

// Stop todo de una sala
app.get('/stop', (req, res) => {
  const salaId = req.query.sala || 'sala1';
  const sala = getSala(salaId);
  
  // Matar procesos activos
  if(sala.procesos.ytdlp){
    try { sala.procesos.ytdlp.kill('SIGKILL'); } catch(e) {}
  }
  if(sala.procesos.ffmpeg){
    try { sala.procesos.ffmpeg.kill('SIGKILL'); } catch(e) {}
  }
  
  sala.cola.length = 0;
  sala.cancionActual = null;
  sala.reproduciendo = false;
  sala.buffer = [];
  sala.bufferIndex = 0;
  
  console.log(`[${salaId}] ⏹️ Radio detenida`);
  res.json({ ok: true });
});

// Ver todas las salas activas
app.get('/salas', (req, res) => {
  const info = [];
  for(const [salaId, sala] of salas.entries()){
    info.push({
      id: salaId,
      actual: sala.cancionActual ? sala.cancionActual.titulo : null,
      cola: sala.cola.length,
      clientes: sala.clientes.length
    });
  }
  res.json(info);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`📻 PixelMafia Radio iniciado en puerto ${PORT}`);
  console.log(`✅ Servidor listo para conexiones`);
  console.log(`� Endpoints disponibles:`);
  console.log(`   - /health     (Estado del servidor)`);
  console.log(`   - /config     (Configuración de URL)`);
  console.log(`   - /play?q=... (Agregar canción)`);
  console.log(`   - /radio/:id  (Stream de audio)`);
});
