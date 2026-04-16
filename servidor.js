// servidor.js - Radio continua con colas por sala
const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const play = require('play-dl');
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

// Limpiar título de emojis y texto innecesario
function limpiarTitulo(titulo) {
  titulo = titulo.replace(/[\u{1F600}-\u{1F64F}]/gu, '');
  titulo = titulo.replace(/[\u{1F300}-\u{1F5FF}]/gu, '');
  titulo = titulo.replace(/[\u{1F680}-\u{1F6FF}]/gu, '');
  titulo = titulo.replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '');
  titulo = titulo.replace(/[\u{2600}-\u{26FF}]/gu, '');
  titulo = titulo.replace(/[\u{2700}-\u{27BF}]/gu, '');
  titulo = titulo.replace(/\(Official.*?\)/gi, '');
  titulo = titulo.replace(/\[Official.*?\]/gi, '');
  titulo = titulo.replace(/\s+/g, ' ').trim();
  if (titulo.length > 80) titulo = titulo.slice(0, 77) + '...';
  return titulo;
}

// Método 1: Buscar con play-dl
async function buscarConPlayDl(query) {
  const esUrl = String(query).startsWith('http');
  let videoInfo;
  if (esUrl) {
    videoInfo = await play.video_info(query);
  } else {
    const searchResults = await play.search(query, { limit: 1, source: { youtube: 'video' } });
    if (!searchResults || searchResults.length === 0) return null;
    videoInfo = await play.video_info(searchResults[0].url);
  }
  if (!videoInfo || !videoInfo.video_details) return null;
  const video = videoInfo.video_details;
  return {
    titulo: limpiarTitulo(video.title),
    duracion: video.durationInSec || 0,
    url: video.url
  };
}

// Método 2: Buscar con YouTube scraping (sin API key)
async function buscarConScraping(query) {
  const https = require('https');
  const queryEncoded = encodeURIComponent(query + ' audio');
  const url = `https://www.youtube.com/results?search_query=${queryEncoded}`;

  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'es-ES,es;q=0.9',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Extraer videoId del HTML de resultados
          const match = data.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
          if (!match) return resolve(null);
          const videoId = match[1];

          // Extraer título
          const tituloMatch = data.match(/"title":{"runs":\[{"text":"([^"]+)"}/);
          const titulo = tituloMatch ? limpiarTitulo(tituloMatch[1]) : `Video ${videoId}`;

          resolve({
            titulo,
            duracion: 0,
            url: `https://www.youtube.com/watch?v=${videoId}`
          });
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

// Buscar con reintentos y múltiples métodos
async function buscarYoutube(query) {
  console.log(`🔍 Buscando canción: "${query}"`);

  // Intentar con play-dl (3 reintentos)
  for (let intento = 1; intento <= 3; intento++) {
    try {
      console.log(`  [play-dl] Intento ${intento}/3...`);
      const resultado = await buscarConPlayDl(query);
      if (resultado) {
        console.log(`✅ Encontrada con play-dl: ${resultado.titulo}`);
        return resultado;
      }
    } catch (e) {
      console.log(`  [play-dl] Error intento ${intento}: ${e.message}`);
      if (intento < 3) await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Fallback: scraping directo de YouTube
  try {
    console.log('  [scraping] Intentando búsqueda alternativa...');
    const resultado = await buscarConScraping(query);
    if (resultado) {
      console.log(`✅ Encontrada con scraping: ${resultado.titulo}`);
      return resultado;
    }
  } catch (e) {
    console.log(`  [scraping] Error: ${e.message}`);
  }

  console.error(`❌ No se encontró "${query}" con ningún método`);
  return null;
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
async function streamCancion(cancion, sala) {
  return new Promise(async (resolve, reject) => {
    try {
      // Obtener stream de audio usando play-dl
      const stream = await play.stream(cancion.url, { quality: 1 }); // quality 1 = highest audio
      
      const ffmpeg = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vn',
        '-f', 'mp3',
        '-b:a', '128k',
        'pipe:1'
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      // Guardar referencia al proceso
      sala.procesos.ffmpeg = ffmpeg;
      
      // Conectar stream de play-dl a ffmpeg
      stream.stream.pipe(ffmpeg.stdin);

      let bytesEnviados = 0;
      let streamTerminado = false;

      ffmpeg.stdout.on('data', (chunk) => {
        // Verificar si debemos detener
        if(!sala.reproduciendo){
          ffmpeg.kill('SIGKILL');
          return;
        }
        
        bytesEnviados += chunk.length;
        
        // Agregar chunk al buffer circular
        sala.buffer.push(chunk);
        if(sala.buffer.length > sala.bufferSize){
          sala.buffer.shift();
        }
        sala.bufferIndex++;
        
        // Broadcast a todos los clientes conectados
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
      });

      ffmpeg.stdout.on('end', () => {
        if(!streamTerminado) {
          streamTerminado = true;
          sala.buffer = [];
          sala.bufferIndex = 0;
          sala.procesos.ffmpeg = null;
          resolve();
        }
      });

      ffmpeg.on('error', (err) => {
        if(!streamTerminado) {
          streamTerminado = true;
          sala.procesos.ffmpeg = null;
          reject(err);
        }
      });

      ffmpeg.on('close', (code) => {
        if(!streamTerminado) {
          streamTerminado = true;
          sala.procesos.ffmpeg = null;
          if(code === 0) {
            resolve();
          } else {
            reject(new Error(`ffmpeg cerrado con código ${code}`));
          }
        }
      });
      
    } catch (err) {
      reject(err);
    }
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
app.get('/play', async (req, res) => {
  const query = req.query.q || req.query.url;
  const salaId = req.query.sala || 'sala1';
  
  console.log(`\n[SERVIDOR] 📥 Request /play recibido`);
  console.log(`[SERVIDOR]    Query: ${query}`);
  console.log(`[SERVIDOR]    Sala: ${salaId}`);
  
  if (!query) return res.status(400).json({ error: 'Falta parametro q o url' });

  const info = await buscarYoutube(query);
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

  const PORT = process.env.PORT || 5000;
  const fs = require('fs');
  
  // Leer URL de Cloudflare del archivo SIEMPRE
  let cloudflareUrl = null;
  try {
    if(fs.existsSync('.cloudflare_url')){
      cloudflareUrl = fs.readFileSync('.cloudflare_url', 'utf8').trim();
      console.log(`[${salaId}] 🌐 URL de Cloudflare leída: ${cloudflareUrl}`);
    }
  } catch(e) {
    console.log(`[${salaId}] ⚠️ Error leyendo archivo:`, e.message);
  }
  
  const HOST = (cloudflareUrl || `http://localhost:${PORT}`).replace(/\/$/, '');
  
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
  const cloudflareUrl = process.env.CLOUDFLARE_URL;
  const publicUrl = cloudflareUrl || 'No configurada';
  
  console.log(`📻 PixelMafia Radio en http://localhost:${PORT}/radio/:salaId`);
  console.log(`🌐 URL pública: ${publicUrl}/radio/:salaId`);
  console.log(`✨ Sistema de colas por sala listo!`);
});
