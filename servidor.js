// servidor.js - Radio continua con colas por sala v2.3 (Spotify integrado)
const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());

// Path absoluto al archivo de cookies
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// Verificar que cookies.txt existe al iniciar
if (fs.existsSync(COOKIES_PATH)) {
  console.log('✅ Archivo cookies.txt encontrado:', COOKIES_PATH);
  const stats = fs.statSync(COOKIES_PATH);
  console.log(`   Tamaño: ${stats.size} bytes`);
} else {
  console.warn('⚠️ Archivo cookies.txt NO encontrado en:', COOKIES_PATH);
}

// ═══════════════════════════════════════════════════════════
// 🎵 INTEGRACIÓN CON SPOTIFY
// ═══════════════════════════════════════════════════════════
const SpotifyWebApi = require('spotify-web-api-node');

// Configurar credenciales de Spotify
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

let spotifyTokenExpires = 0;

// Función para obtener/renovar token de Spotify
async function refreshSpotifyToken() {
  const now = Date.now();
  if (now < spotifyTokenExpires - 60000) {
    // Token aún válido (con margen de 1 minuto)
    return true;
  }
  
  try {
    console.log('🎵 [Spotify] Renovando token de acceso...');
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body['access_token']);
    spotifyTokenExpires = now + (data.body['expires_in'] * 1000);
    console.log('✅ [Spotify] Token renovado exitosamente');
    return true;
  } catch (error) {
    console.error('❌ [Spotify] Error al obtener token:', error.message);
    return false;
  }
}

// Buscar canción en Spotify y luego buscar audio en YouTube
async function buscarSpotify(query) {
  const tokenValid = await refreshSpotifyToken();
  if (!tokenValid) {
    console.error('❌ [Spotify] No se pudo obtener token válido');
    return null;
  }
  
  try {
    console.log(`🎵 [Spotify] Buscando: "${query}"`);
    
    // Buscar tracks
    const result = await spotifyApi.searchTracks(query, { limit: 1 });
    
    if (result.body.tracks.items.length === 0) {
      console.log('⚠️ [Spotify] No se encontraron resultados');
      return null;
    }
    
    const track = result.body.tracks.items[0];
    
    console.log(`✅ [Spotify] Encontrada: ${track.name} - ${track.artists[0].name}`);
    
    // Construir query exacta para YouTube usando nombre de Spotify
    const queryExacta = `${track.name} ${track.artists.map(a => a.name).join(' ')}`;
    console.log(`🎵 [Spotify→YouTube] Buscando audio: "${queryExacta}"`);
    
    // Buscar en YouTube usando el nombre exacto de Spotify
    let youtubeResult = null;
    
    // Intentar con yt-dlp primero
    try {
      youtubeResult = await buscarConYtdlp(queryExacta);
      if (youtubeResult) {
        console.log(`✅ [Spotify→YouTube] Audio encontrado: ${youtubeResult.titulo}`);
      }
    } catch (e) {
      console.log(`  [yt-dlp] Error: ${e.message}`);
    }
    
    // Si falló, intentar con scraping
    if (!youtubeResult) {
      try {
        await delayIfNeeded();
        youtubeResult = await buscarConScraping(queryExacta);
        if (youtubeResult) {
          console.log(`✅ [Spotify→YouTube] Audio encontrado (scraping): ${youtubeResult.titulo}`);
        }
      } catch (e) {
        console.log(`  [scraping] Error: ${e.message}`);
      }
    }
    
    if (!youtubeResult) {
      console.warn(`⚠️ [Spotify→YouTube] No se encontró audio para: ${queryExacta}`);
      return null;
    }
    
    // Retornar con información de Spotify + URL de YouTube
    return {
      titulo: `${track.name} - ${track.artists.map(a => a.name).join(', ')}`,
      duracion: youtubeResult.duracion || Math.floor(track.duration_ms / 1000),
      url: youtubeResult.url, // URL de YouTube (para reproducir)
      esSpotify: true,
      artista: track.artists[0].name,
      nombre: track.name,
      album: track.album.name,
      imagen: track.album.images[0]?.url,
      spotifyUrl: track.external_urls.spotify // Para referencia
    };
    
  } catch (error) {
    console.error('❌ [Spotify] Error en búsqueda:', error.message);
    return null;
  }
}

// Verificar configuración de Spotify al iniciar
if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
  console.log('🎵 [Spotify] Configuración detectada');
  refreshSpotifyToken();
} else {
  console.warn('⚠️ [Spotify] No configurado. SPOTIFY_CLIENT_ID y/o SPOTIFY_CLIENT_SECRET faltantes');
  console.warn('   Obtén credenciales en: https://developer.spotify.com/dashboard');
}

// Sistema de colas por sala con buffer compartido
const salas = new Map(); // salaId -> { cola, cancionActual, reproduciendo, clientes, buffer, bufferIndex, procesos, modoFondo, cancionesFondo }

// Playlist de música de fondo - STREAMS DE RADIO PÚBLICOS 24/7
// Estos no requieren yt-dlp ni play-dl, funcionan directo con ffmpeg
const PLAYLIST_FONDO = [
  {
    titulo: '📻 Lofi Radio 24/7',
    url: 'https://stream.zeno.fm/0r0xa792kwzuv',
    duracion: 0,
    esStream: true  // Indica que es stream directo, no YouTube
  },
  {
    titulo: '📻 Chill Hop Radio',
    url: 'https://stream.zeno.fm/qqkk6k8syy8uv',
    duracion: 0,
    esStream: true
  },
  {
    titulo: '📻 Relaxing Lofi',
    url: 'https://stream.zeno.fm/gq6hvq8syy8uv',
    duracion: 0,
    esStream: true
  }
];

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
            procesos: { ytdlp: null, ffmpeg: null }, // Procesos activos
            modoFondo: true, // Por defecto, reproducir música de fondo
            cancionesFondo: [...PLAYLIST_FONDO], // Copia de la playlist
            indiceFondo: 0 // Índice actual en la playlist de fondo
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

// Método 2: Buscar con yt-dlp usando cookies
async function buscarConYtdlp(query) {
  return new Promise((resolve) => {
    const esUrl = String(query).startsWith('http');
    let args;
    
    if (esUrl) {
      // Si es URL directa, obtener info del video
      args = [
        '-j',  // Output JSON
        '--cookies', COOKIES_PATH,
        '--no-check-certificates',
        '--no-warnings',
        query
      ];
    } else {
      // Si es búsqueda, buscar y obtener primer resultado
      args = [
        'ytsearch1:' + query,  // Buscar en YouTube, 1 resultado
        '-j',  // Output JSON
        '--cookies', COOKIES_PATH,
        '--no-check-certificates',
        '--no-warnings'
      ];
    }
    
    console.log(`  [yt-dlp] Buscando: "${query}"`);
    
    const ytdlp = spawn('yt-dlp', args, { 
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000  // 30 segundos timeout
    });
    
    let output = '';
    let errorOutput = '';
    
    ytdlp.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ytdlp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    ytdlp.on('close', (code) => {
      if (code !== 0) {
        console.log(`  [yt-dlp] Error (code ${code}): ${errorOutput.slice(0, 200)}`);
        return resolve(null);
      }
      
      try {
        // Parsear JSON output
        const lines = output.trim().split('\n');
        const jsonLine = lines.find(line => line.startsWith('{'));
        if (!jsonLine) return resolve(null);
        
        const info = JSON.parse(jsonLine);
        
        resolve({
          titulo: limpiarTitulo(info.title),
          duracion: info.duration || 0,
          url: info.webpage_url || info.url
        });
      } catch (e) {
        console.log(`  [yt-dlp] Error parseando JSON: ${e.message}`);
        resolve(null);
      }
    });
    
    ytdlp.on('error', (err) => {
      console.log(`  [yt-dlp] Spawn error: ${err.message}`);
      resolve(null);
    });
  });
}

// Método 3: Buscar con YouTube scraping (sin API key)
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

// Delay entre requests para evitar rate limits
const DELAY_BETWEEN_REQUESTS = 5000; // 5 segundos
let lastRequestTime = 0;

async function delayIfNeeded() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < DELAY_BETWEEN_REQUESTS) {
    const waitTime = DELAY_BETWEEN_REQUESTS - elapsed;
    console.log(`⏳ Esperando ${waitTime}ms para evitar rate limit...`);
    await new Promise(r => setTimeout(r, waitTime));
  }
  lastRequestTime = Date.now();
}

// Buscar con reintentos y múltiples métodos
async function buscarYoutube(query) {
  console.log(`🔍 Buscando canción: "${query}"`);
  
  await delayIfNeeded();

  // MÉTODO 0: Spotify (si está configurado - NO usa IPs de cloud)
  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    try {
      console.log('  [método 0] Intentando con Spotify...');
      const resultado = await buscarSpotify(query);
      if (resultado) {
        console.log(`✅ Encontrada con Spotify: ${resultado.titulo}`);
        return resultado;
      }
    } catch (e) {
      console.log(`  [Spotify] Error: ${e.message}`);
    }
  }

  // MÉTODO 1: yt-dlp con cookies (más confiable con autenticación)
  try {
    console.log('  [método 1] Intentando con yt-dlp + cookies...');
    const resultado = await buscarConYtdlp(query);
    if (resultado) {
      console.log(`✅ Encontrada con yt-dlp: ${resultado.titulo}`);
      return resultado;
    }
  } catch (e) {
    console.log(`  [yt-dlp] Error: ${e.message}`);
  }

  // MÉTODO 2: Fallback scraping directo de YouTube (play-dl deshabilitado - causa crashes)
  try {
    console.log('  [método 2] Intentando búsqueda alternativa (scraping)...');
    await delayIfNeeded();
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
    
    // Si no hay canciones en cola, reproducir música de fondo
    if(sala.cola.length === 0) {
        if(sala.modoFondo && sala.cancionesFondo.length > 0) {
            console.log(`[${salaId}] 📭 Cola vacía - Iniciando música de fondo...`);
            await reproducirFondo(salaId);
            return;
        } else {
            console.log(`[${salaId}] 📭 Cola vacía - Esperando canciones...`);
            return;
        }
    }
    
    // NOTA: El servidor transmite siempre, con o sin clientes
    // El buffer se mantiene lleno para que nuevos clientes se sincronicen inmediatamente
    
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
        // Si falló, devolver canción a la cola para reintentar después
        if (sala.cancionActual && !sala.cancionActual.esFondo) {
            console.log(`[${salaId}] 🔄 Devolviendo canción a la cola para reintentar...`);
            sala.cola.unshift(sala.cancionActual);
        }
    }
    
    sala.reproduciendo = false;
    
    if (sala.cancionActual) {
        console.log(`[${salaId}] ✅ Canción terminada:`, sala.cancionActual.titulo);
        sala.cancionActual = null;
    }
    
    // Reproducir siguiente automáticamente
    if(sala.cola.length > 0){
        console.log(`[${salaId}] 🔄 Hay más canciones, reproduciendo siguiente...`);
        setTimeout(() => reproducirSiguiente(salaId), 1000);
    } else if(sala.modoFondo) {
        console.log(`[${salaId}] 📭 Cola vacía - Volviendo a música de fondo...`);
        setTimeout(() => reproducirSiguiente(salaId), 1000);
    } else {
        console.log(`[${salaId}] � No hay más canciones en cola, esperando...`);
    }
}

// Reproducir música de fondo (lofi/chill)
async function reproducirFondo(salaId) {
    const sala = getSala(salaId);
    
    if(sala.reproduciendo) {
        console.log(`[${salaId}] ⏸️ Ya está reproduciendo, no iniciar fondo`);
        return;
    }
    
    // El servidor transmite siempre, sin importar si hay clientes
    
    // Seleccionar canción de fondo (URL directa, sin búsqueda)
    const cancionFondo = sala.cancionesFondo[sala.indiceFondo % sala.cancionesFondo.length];
    sala.indiceFondo++;
    
    console.log(`[${salaId}] 🎵 Usando música de fondo (URL directa): "${cancionFondo.titulo}"`);
    
    try {
        // Usar URL directa sin búsqueda - evita bloqueos de YouTube
        const info = {
          titulo: cancionFondo.titulo,
          url: cancionFondo.url,
          duracion: cancionFondo.duracion
        };
        
        sala.reproduciendo = true;
        sala.cancionActual = { ...info, esFondo: true, esStream: cancionFondo.esStream || false };
        
        console.log(`[${salaId}] ▶️ Reproduciendo fondo:`, info.titulo);
        console.log(`[${salaId}] 🔗 URL:`, info.url);
        
        await streamCancion(sala.cancionActual, sala);
        
        sala.reproduciendo = false;
        sala.cancionActual = null;
        
        // Continuar con siguiente canción de fondo
        console.log(`[${salaId}] 🔄 Fondo terminado, siguiente...`);
        setTimeout(() => reproducirSiguiente(salaId), 1000);
        
    } catch(e) {
        console.error(`[${salaId}] ❌ Error en fondo:`, e.message);
        sala.reproduciendo = false;
        // No propagar el error - solo loguear y reintentar
        console.log(`[${salaId}] 🔄 Reintentando fondo en 60s...`);
        setTimeout(() => reproducirFondo(salaId), 60000);
    }
}

// Stream de una canción con buffer compartido para sincronización
async function streamCancion(cancion, sala) {
  return new Promise(async (resolve, reject) => {
    let stream;
    let usarYtdlp = false;
    let esStreamDirecto = cancion.esStream === true;
    
    // Si es stream de radio directo (no YouTube), conectar ffmpeg directo
    if(esStreamDirecto) {
      console.log(`[stream] 📻 Stream de radio directo detectado: ${cancion.url}`);
    } else {
      // Usar yt-dlp directamente (play-dl deshabilitado - causa crashes)
      console.log(`[stream] � Usando yt-dlp con cookies para YouTube...`);
      usarYtdlp = true;
    }
    
    try {
      let ffmpeg;
      let ytdlpProcess = null;
      
      if(esStreamDirecto) {
        // Stream directo: ffmpeg se conecta directamente a la URL
        console.log(`[stream] � Conectando ffmpeg a stream de radio...`);
        ffmpeg = spawn('ffmpeg', [
          '-hide_banner', '-loglevel', 'error',
          '-i', cancion.url,     // Conectar directo a la URL del stream
          '-vn',                  // Sin video
          '-f', 'mp3',            // Formato MP3
          '-b:a', '128k',         // Bitrate 128k
          '-ar', '44100',         // Sample rate 44.1kHz
          '-ac', '2',             // 2 canales (stereo)
          'pipe:1'                // Salida a pipe
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        
        console.log(`[stream] ✅ ffmpeg conectado a stream de radio`);
        
      } else if(usarYtdlp) {
        // Usar yt-dlp → ffmpeg para obtener y convertir audio
        console.log(`[stream] 🔊 Iniciando yt-dlp + ffmpeg...`);
        
        // Primero iniciar yt-dlp con cookies para autenticación
        console.log(`[stream] 📁 Usando cookies: ${COOKIES_PATH}`);
        ytdlpProcess = spawn('yt-dlp', [
          '-f', 'bestaudio[ext=m4a]/bestaudio/best',
          '-o', '-',
          '--no-check-certificates',
          '--no-warnings',
          '--quiet',
          '--cookies', COOKIES_PATH,  // Usar cookies de YouTube (path absoluto)
          '--extractor-args', 'youtube:player_client=android',  // Bypass bot detection con Android client
          cancion.url
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        
        // Luego iniciar ffmpeg que recibe de yt-dlp
        ffmpeg = spawn('ffmpeg', [
          '-hide_banner', '-loglevel', 'error',
          '-i', 'pipe:0',
          '-vn',
          '-f', 'mp3',
          '-b:a', '128k',
          'pipe:1'
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        
        // Conectar yt-dlp stdout a ffmpeg stdin
        ytdlpProcess.stdout.pipe(ffmpeg.stdin);
        ytdlpProcess.stderr.on('data', (data) => {
          console.log(`[yt-dlp] ${data.toString().trim()}`);
        });
        ytdlpProcess.on('error', (err) => {
          console.error(`[yt-dlp] Error: ${err.message}`);
        });
        
        console.log(`[stream] ✅ yt-dlp + ffmpeg iniciados`);
      } else {
        // Usar ffmpeg con stream de play-dl
        ffmpeg = spawn('ffmpeg', [
          '-hide_banner', '-loglevel', 'error',
          '-i', 'pipe:0',
          '-vn',
          '-f', 'mp3',
          '-b:a', '128k',
          'pipe:1'
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        
        // Conectar stream de play-dl a ffmpeg
        if(stream && stream.stream) {
          stream.stream.pipe(ffmpeg.stdin);
        }
      }

      // Guardar referencia al proceso
      sala.procesos.ffmpeg = ffmpeg;
      if(ytdlpProcess) sala.procesos.ytdlp = ytdlpProcess;

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
  
  // Si el servidor no está reproduciendo nada, iniciar automáticamente
  // La radio funciona 24/7 con o sin clientes
  if(!sala.reproduciendo && !sala.cancionActual){
    console.log(`[${salaId}] 🎬 Cliente conectado - Iniciando transmisión continua...`);
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
  try {
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
  console.log(`[${salaId}]    - Es fondo:`, sala.cancionActual?.esFondo || false);
  console.log(`[${salaId}]    - Total en cola:`, sala.cola.length);
  
  // Si está reproduciendo música de fondo, interrumpir y poner la canción solicitada
  if(sala.reproduciendo && sala.cancionActual?.esFondo) {
    console.log(`[${salaId}] 🎵 Interrumpiendo música de fondo para reproducir canción solicitada...`);
    // Matar procesos actuales para detener el fondo
    try {
      if(sala.procesos.ffmpeg) {
        sala.procesos.ffmpeg.kill('SIGKILL');
        sala.procesos.ffmpeg = null;
      }
      if(sala.procesos.ytdlp) {
        sala.procesos.ytdlp.kill('SIGKILL');
        sala.procesos.ytdlp = null;
      }
    } catch(e) {
      console.log(`[${salaId}] ⚠️ Error deteniendo fondo:`, e.message);
    }
    sala.reproduciendo = false;
    sala.cancionActual = null;
    // Limpiar buffer
    sala.buffer = [];
    sala.bufferIndex = 0;
    
    // Iniciar reproducción de la canción solicitada inmediatamente
    setTimeout(() => reproducirSiguiente(salaId), 500);
  }
  // Si no está reproduciendo nada, iniciar
  else if(!sala.reproduciendo && sala.clientes.length > 0) {
    console.log(`[${salaId}] 🎵 Iniciando reproducción...`);
    setTimeout(() => reproducirSiguiente(salaId), 500);
  }

  // Detectar URL pública automáticamente
  function getPublicUrl(req) {
    // 1. Variable de entorno de Render
    if (process.env.RENDER_EXTERNAL_URL) {
      return process.env.RENDER_EXTERNAL_URL;
    }
    
    // 2. Headers de proxy (Cloudflare, Nginx, etc)
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`;
    
    // Si es un dominio público (no localhost), usarlo
    if (!host.includes('localhost') && !host.includes('127.0.0.1')) {
      return `${protocol}://${host}`;
    }
    
    // 3. Intentar leer archivo de Cloudflare
    try {
      const fs = require('fs');
      if(fs.existsSync('.cloudflare_url')){
        const url = fs.readFileSync('.cloudflare_url', 'utf8').trim();
        console.log(`[${salaId}] 🌐 URL de Cloudflare leída: ${url}`);
        return url;
      }
    } catch(e) {}
    
    // 4. Fallback a localhost
    return `http://localhost:${PORT}`;
  }
  
  const HOST = getPublicUrl(req).replace(/\/$/, '');
  
  console.log(`[${salaId}] 🌐 HOST final para respuesta:`, HOST);

  // NO iniciar reproducción automáticamente
  // Esperará a que se conecte un cliente
  console.log(`[${salaId}] 📋 Canción agregada a cola. Esperando cliente para iniciar...`);

  res.json({
    nombre: info.titulo,
    titulo: info.titulo,
    url: info.url,
    duracion: info.duracion,
    posicion: sala.cancionActual ? sala.cola.length + 1 : 1,
    radioUrl: `${HOST}/stream/${salaId}`,
    esFondo: false
  });
  } catch (error) {
    console.error(`[PLAY] ❌ Error en /play:`, error.message);
    return res.status(500).json({ error: 'Error interno del servidor al buscar la canción' });
  }
});

// Info de la canción actual y cola de una sala
app.get('/now', (req, res) => {
  const salaId = req.query.sala || 'sala1';
  const sala = getSala(salaId);
  
  res.json({
    actual: sala.cancionActual ? {
      nombre: sala.cancionActual.titulo,
      titulo: sala.cancionActual.titulo,
      url: sala.cancionActual.url,
      duracion: sala.cancionActual.duracion,
      esFondo: sala.cancionActual.esFondo || false
    } : null,
    cola: sala.cola.map(c => ({ nombre: c.titulo, titulo: c.titulo, url: c.url })),
    totalCola: sala.cola.length,
    radioUrl: `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost'}/stream/${salaId}`
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    salasActivas: salas.size,
    version: '2.0'
  });
});

// Endpoint STREAM simplificado compatible con IMVU (flujo MP3 continuo)
// Este endpoint crea un stream directo sin buffer de chunks
app.get('/stream/:salaId', async (req, res) => {
  const salaId = req.params.salaId;
  const sala = getSala(salaId);
  
  console.log(`[${salaId}] 🎧 STREAM - Cliente conectado`);
  
  // Headers estándar para stream de audio MP3
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Si no hay canción reproduciéndose, iniciar
  if(!sala.reproduciendo && !sala.cancionActual){
    console.log(`[${salaId}] 🎬 Iniciando transmisión continua...`);
    reproducirSiguiente(salaId);
    
    // Esperar a que inicie el stream
    let intentos = 0;
    while(!sala.reproduciendo && intentos < 30){
      await new Promise(r => setTimeout(r, 1000));
      intentos++;
    }
  }
  
  // Verificar si hay stream activo
  if(!sala.reproduciendo){
    console.log(`[${salaId}] ⏳ Esperando stream...`);
    // Enviar silencio o mensaje
    res.status(503).end('Stream no disponible');
    return;
  }
  
  // Agregar cliente al sistema de broadcast
  sala.clientes.push(res);
  console.log(`[${salaId}] 👥 Clientes conectados: ${sala.clientes.length}`);
  
  // Manejar desconexión
  req.on('close', () => {
    const index = sala.clientes.indexOf(res);
    if(index > -1) sala.clientes.splice(index, 1);
    console.log(`[${salaId}] 📻 Cliente desconectado. Total: ${sala.clientes.length}`);
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  const cloudflareUrl = process.env.CLOUDFLARE_URL;
  const publicUrl = cloudflareUrl || 'No configurada';
  
  console.log(`📻 PixelMafia Radio en http://localhost:${PORT}/stream/:salaId`);
  console.log(`🌐 URL pública: ${publicUrl}/stream/:salaId`);
  console.log(`✨ Sistema de colas por sala listo!`);
  console.log(`🎵 Modo: Radio 24/7 con música de fondo (lofi)`);
  
  // Iniciar sala de prueba automáticamente para que siempre haya audio
  const salaDemo = 'demo';
  const sala = getSala(salaDemo);
  sala.modoFondo = true;
  console.log(`\n🎬 Iniciando sala demo automáticamente...`);
  // Delay inicial para evitar rate limit al arrancar
  setTimeout(() => {
    console.log(`[${salaDemo}] 🚀 Iniciando transmisión con delay de seguridad...`);
    reproducirSiguiente(salaDemo);
  }, 10000); // 10 segundos de delay inicial
});
