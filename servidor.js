// Panel + Servidor de Radio Integrado - Pixel Mafia Bot
// Combina: Panel de Control + Servidor de Radio + Multi-cuentas

const express = require('express');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const fs = require('fs');
const cors = require('cors');

// Importar servidor de radio (usaremos el nuevo con yt-dlp/play-dl)
const play = require('play-dl');
const https = require('https');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PANEL_PORT || 8080;

// ============================================
// ESTADO GLOBAL
// ============================================
const procesosBots = {};
const botsActivos = {};
const logsPanel = [];
const salasRadio = new Map();

// ============================================
// FUNCIONES DE LOGGING
// ============================================
function addLog(tipo, mensaje, data = {}) {
    const entry = { 
        time: new Date().toLocaleTimeString(), 
        tipo, 
        mensaje,
        data,
        id: Date.now()
    };
    logsPanel.push(entry);
    if (logsPanel.length > 1000) logsPanel.shift();
    
    console.log(`[${entry.time}] [${tipo.toUpperCase()}] ${mensaje}`);
    
    // Broadcast a clientes WebSocket
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'log', data: entry }));
        }
    });
}

// ============================================
// SERVIDOR DE RADIO (Sistema de Colas)
// ============================================

function getSalaRadio(salaId) {
    if (!salasRadio.has(salaId)) {
        salasRadio.set(salaId, {
            cola: [],
            cancionActual: null,
            reproduciendo: false,
            clientes: [],
            buffer: [],
            bufferIndex: 0,
            bufferSize: 150,
            procesos: { ytdlp: null, ffmpeg: null }
        });
    }
    return salasRadio.get(salaId);
}

function limpiarTitulo(titulo) {
    if (!titulo) return 'Sin titulo';
    titulo = titulo.replace(/[\u{1F600}-\u{1F64F}]/gu, '');
    titulo = titulo.replace(/[\u{1F300}-\u{1F5FF}]/gu, '');
    titulo = titulo.replace(/[\u{1F680}-\u{1F6FF}]/gu, '');
    titulo = titulo.replace(/\(Official.*?\)/gi, '');
    titulo = titulo.replace(/\[Official.*?\]/gi, '');
    titulo = titulo.replace(/\s+/g, ' ').trim();
    if (titulo.length > 80) titulo = titulo.slice(0, 77) + '...';
    return titulo;
}

// Busqueda con play-dl (3 reintentos) + scraping fallback
async function buscarYoutube(query) {
    addLog('info', `🔍 Buscando: "${query}"`);
    
    // Metodo 1: play-dl (3 intentos)
    for (let i = 1; i <= 3; i++) {
        try {
            addLog('info', `  [play-dl] Intento ${i}/3...`);
            
            const esUrl = String(query).startsWith('http');
            let videoInfo;
            
            if (esUrl) {
                videoInfo = await play.video_info(query);
            } else {
                const results = await play.search(query, { limit: 3, source: { youtube: 'video' } });
                if (!results?.length) continue;
                
                for (const r of results) {
                    try {
                        videoInfo = await play.video_info(r.url);
                        if (videoInfo?.video_details) break;
                    } catch (e) { continue; }
                }
            }
            
            if (videoInfo?.video_details) {
                const v = videoInfo.video_details;
                addLog('success', `✅ Encontrado con play-dl: "${v.title}"`);
                return {
                    titulo: limpiarTitulo(v.title),
                    duracion: v.durationInSec || 0,
                    url: v.url
                };
            }
        } catch (e) {
            addLog('warn', `  [play-dl] Error intento ${i}: ${e.message}`);
            if (i < 3) await new Promise(r => setTimeout(r, i * 1000));
        }
    }
    
    // Metodo 2: Scraping
    addLog('info', `  [scraping] Intentando búsqueda alternativa...`);
    try {
        const result = await buscarConScraping(query);
        if (result) {
            addLog('success', `✅ Encontrado con scraping: "${result.titulo}"`);
            return result;
        }
    } catch (e) {
        addLog('error', `  [scraping] Error: ${e.message}`);
    }
    
    addLog('error', `❌ No se encontró: "${query}"`);
    return null;
}

async function buscarConScraping(query) {
    return new Promise((resolve) => {
        const encoded = encodeURIComponent(query + ' audio');
        const url = `https://www.youtube.com/results?search_query=${encoded}`;
        
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
                'Accept-Language': 'es-ES,es;q=0.9'
            },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const match = data.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
                    if (!match) return resolve(null);
                    
                    const videoId = match[1];
                    const tituloMatch = data.match(/<title>([^<]+) - YouTube<\/title>/);
                    const titulo = tituloMatch ? tituloMatch[1] : `Video ${videoId}`;
                    
                    resolve({
                        titulo: limpiarTitulo(titulo),
                        duracion: 0,
                        url: `https://youtube.com/watch?v=${videoId}`
                    });
                } catch (e) { resolve(null); }
            });
        });
        
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.setTimeout(10000);
    });
}

async function streamCancion(cancion, sala) {
    return new Promise(async (resolve, reject) => {
        try {
            const stream = await play.stream(cancion.url, { quality: 1 });
            
            const ffmpeg = spawn('ffmpeg', [
                '-hide_banner', '-loglevel', 'error',
                '-i', 'pipe:0', '-vn', '-f', 'mp3', '-b:a', '128k', 'pipe:1'
            ], { stdio: ['pipe', 'pipe', 'pipe'] });
            
            sala.procesos.ffmpeg = ffmpeg;
            stream.stream.pipe(ffmpeg.stdin);
            
            let terminado = false;
            
            ffmpeg.stdout.on('data', (chunk) => {
                if (!sala.reproduciendo) {
                    ffmpeg.kill('SIGKILL');
                    return;
                }
                
                sala.buffer.push(chunk);
                if (sala.buffer.length > sala.bufferSize) sala.buffer.shift();
                sala.bufferIndex++;
                
                sala.clientes.forEach(c => {
                    try { if (c.writable) c.write(chunk); } catch (e) {}
                });
            });
            
            ffmpeg.on('close', (code) => {
                if (!terminado) {
                    terminado = true;
                    sala.procesos.ffmpeg = null;
                    sala.buffer = [];
                    if (code === 0 || code === null) resolve();
                    else reject(new Error(`ffmpeg ${code}`));
                }
            });
            
            ffmpeg.on('error', (err) => {
                if (!terminado) { terminado = true; reject(err); }
            });
        } catch (err) { reject(err); }
    });
}

async function reproducirSiguiente(salaId) {
    const sala = getSalaRadio(salaId);
    
    if (sala.reproduciendo || sala.cola.length === 0) return;
    if (sala.clientes.length === 0) {
        setTimeout(() => reproducirSiguiente(salaId), 2000);
        return;
    }
    
    sala.reproduciendo = true;
    sala.cancionActual = sala.cola.shift();
    
    addLog('info', `▶️ [Radio ${salaId}] Reproduciendo: "${sala.cancionActual.titulo}"`);
    
    try {
        await streamCancion(sala.cancionActual, sala);
        addLog('info', `✅ [Radio ${salaId}] Canción terminada`);
    } catch (e) {
        addLog('error', `❌ [Radio ${salaId}] Error: ${e.message}`);
    }
    
    sala.reproduciendo = false;
    sala.cancionActual = null;
    sala.buffer = [];
    
    if (sala.cola.length > 0) {
        setTimeout(() => reproducirSiguiente(salaId), 1000);
    }
}

// ============================================
// MIDDLEWARE Y CONFIG
// ============================================
app.use(cors());
app.use(express.json());

// ============================================
// ENDPOINTS DE RADIO
// ============================================

app.get('/radio/:salaId', (req, res) => {
    const salaId = req.params.salaId;
    const sala = getSalaRadio(salaId);
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('icy-name', 'PixelMafia Radio');
    
    if (sala.buffer.length > 0) {
        const startIdx = Math.max(0, sala.buffer.length - 20);
        for (let i = startIdx; i < sala.buffer.length; i++) {
            try { res.write(sala.buffer[i]); } catch (e) { break; }
        }
    }
    
    sala.clientes.push(res);
    addLog('info', `📻 [${salaId}] Cliente conectado. Total: ${sala.clientes.length}`);
    
    if (sala.clientes.length === 1 && !sala.reproduciendo && sala.cola.length > 0) {
        setTimeout(() => reproducirSiguiente(salaId), 500);
    }
    
    res.on('close', () => {
        const idx = sala.clientes.indexOf(res);
        if (idx > -1) sala.clientes.splice(idx, 1);
    });
});

app.get('/play', async (req, res) => {
    const query = req.query.q || req.query.url;
    const salaId = req.query.sala || 'default';
    
    if (!query) {
        return res.status(400).json({ error: 'Falta parametro q o url' });
    }
    
    const info = await buscarYoutube(query);
    if (!info) {
        return res.status(404).json({ 
            error: 'No encontrado',
            intentado: ['play-dl (3x)', 'youtube scraping']
        });
    }
    
    const sala = getSalaRadio(salaId);
    sala.cola.push(info);
    
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['host'] || `localhost:${PORT}`;
    
    if (sala.clientes.length > 0 && !sala.reproduciendo) {
        setTimeout(() => reproducirSiguiente(salaId), 500);
    }
    
    res.json({
        exito: true,
        titulo: info.titulo,
        duracion: info.duracion,
        posicion: sala.cola.length,
        radioUrl: `${protocol}://${host}/radio/${salaId}`
    });
});

app.get('/queue', (req, res) => {
    const salaId = req.query.sala || 'default';
    const sala = getSalaRadio(salaId);
    res.json({
        actual: sala.cancionActual?.titulo || 'Nada',
        cola: sala.cola.map((c, i) => `${i+1}. ${c.titulo}`),
        total: sala.cola.length
    });
});

app.get('/skip', (req, res) => {
    const salaId = req.query.sala || 'default';
    const sala = getSalaRadio(salaId);
    
    if (sala.procesos.ffmpeg) {
        try { sala.procesos.ffmpeg.kill('SIGKILL'); } catch (e) {}
    }
    
    sala.reproduciendo = false;
    sala.cancionActual = null;
    sala.buffer = [];
    
    setTimeout(() => reproducirSiguiente(salaId), 500);
    res.json({ ok: true, mensaje: 'Canción saltada' });
});

// ============================================
// WEBSOCKET
// ============================================

wss.on('connection', (ws) => {
    addLog('info', '👤 Cliente conectado al panel');
    
    ws.send(JSON.stringify({ 
        type: 'logs', 
        data: logsPanel.slice(-50) 
    }));
    
    ws.send(JSON.stringify({ 
        type: 'status', 
        data: { 
            bots: Object.values(botsActivos),
            radio: Array.from(salasRadio.entries()).map(([id, s]) => ({
                id,
                actual: s.cancionActual?.titulo,
                cola: s.cola.length,
                clientes: s.clientes.length
            }))
        }
    }));
    
    ws.on('close', () => {
        addLog('info', '👤 Cliente desconectado');
    });
});

function broadcastStatus() {
    const status = {
        bots: Object.values(botsActivos),
        radio: Array.from(salasRadio.entries()).map(([id, s]) => ({
            id,
            actual: s.cancionActual?.titulo,
            cola: s.cola.length,
            clientes: s.clientes.length
        }))
    };
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'status', data: status }));
        }
    });
}

// ============================================
// API DE BOTS
// ============================================

app.post('/api/bot/start', async (req, res) => {
    const { 
        id, 
        nombre, 
        tipo = 'music',
        salas = [],
        usuario,
        password,
        headless = true,
        radioServer = `http://localhost:${PORT}`
    } = req.body;
    
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    if (!salas.length) return res.status(400).json({ error: 'Se requiere al menos una sala' });
    if (procesosBots[id]) return res.json({ error: 'Bot ya está corriendo' });
    
    const rootDir = __dirname;
    const script = salas.length > 1 
        ? path.join(rootDir, 'bots', 'music', 'bot-multi.js')
        : path.join(rootDir, 'bots', 'music', 'bot.js');
    
    if (!fs.existsSync(script)) {
        return res.status(500).json({ error: `Script no encontrado: ${script}` });
    }
    
    const botName = nombre || `${tipo}-bot-${id}`;
    addLog('info', `🚀 Iniciando bot "${botName}" con ${salas.length} sala(s)...`);
    
    const env = {
        ...process.env,
        BOT_NAME: botName,
        BOT_ID: id,
        HEADLESS: String(headless),
        RADIO_SERVER_URL: radioServer,
        BOT_SESSION_DIR: path.join(rootDir, 'instances', id, 'session')
    };
    
    if (salas.length > 1) {
        env.BOT_SALAS = JSON.stringify(salas);
    } else {
        env.BOT_ROOM_URL = salas[0].url;
        env.BOT_CATEGORIA = salas[0].categoria || 'GA';
    }
    
    if (usuario) env.IMVU_USERNAME = usuario;
    if (password) env.IMVU_PASSWORD = password;
    
    // Limpiar debug de puppeteer
    delete env.DEBUG;
    delete env.PUPPETEER_DEBUG;
    
    fs.mkdirSync(env.BOT_SESSION_DIR, { recursive: true });
    
    const proc = spawn('node', [script], {
        cwd: rootDir,
        env,
        windowsHide: true
    });
    
    proc.stdout.on('data', (d) => {
        d.toString().trim().split('\n').forEach(line => {
            if (!line.trim()) return;
            if (line.includes('puppeteer:protocol')) return;
            if (line.includes('DevTools listening')) return;
            
            let tipo = 'bot';
            if (line.includes('❌') || line.includes('Error')) tipo = 'error';
            else if (line.includes('✅')) tipo = 'success';
            else if (line.includes('🔐')) tipo = '2fa';
            
            addLog(tipo, `[${id}] ${line}`);
        });
    });
    
    proc.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg) addLog('error', `[${id}] ${msg}`);
    });
    
    proc.on('close', (code) => {
        addLog('info', `🏁 Bot ${id} finalizado (código: ${code})`);
        delete procesosBots[id];
        delete botsActivos[id];
        broadcastStatus();
    });
    
    procesosBots[id] = proc;
    botsActivos[id] = {
        id,
        nombre: botName,
        tipo,
        salas: salas.length,
        pid: proc.pid,
        inicio: new Date().toISOString()
    };
    
    broadcastStatus();
    
    res.json({ 
        ok: true, 
        id,
        pid: proc.pid,
        mensaje: `Bot "${botName}" iniciado`,
        radioServer: `${radioServer}/radio/${id}`
    });
});

app.post('/api/bot/stop', (req, res) => {
    const { id } = req.body;
    if (!id || !procesosBots[id]) {
        return res.status(404).json({ error: 'Bot no encontrado' });
    }
    
    addLog('info', `🛑 Deteniendo bot ${id}...`);
    procesosBots[id].kill('SIGTERM');
    
    setTimeout(() => {
        if (procesosBots[id] && !procesosBots[id].killed) {
            procesosBots[id].kill('SIGKILL');
        }
    }, 3000);
    
    res.json({ ok: true });
});

app.post('/api/bot/stop-all', (req, res) => {
    addLog('info', '🛑 Deteniendo todos los bots...');
    
    Object.keys(procesosBots).forEach(id => {
        try { procesosBots[id].kill('SIGTERM'); } catch (e) {}
    });
    
    setTimeout(() => {
        Object.keys(procesosBots).forEach(id => {
            try { 
                if (!procesosBots[id].killed) {
                    procesosBots[id].kill('SIGKILL');
                }
            } catch (e) {}
            delete procesosBots[id];
        });
        Object.keys(botsActivos).forEach(k => delete botsActivos[k]);
        broadcastStatus();
    }, 2000);
    
    res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
    res.json({
        bots: Object.values(botsActivos),
        radio: Array.from(salasRadio.entries()).map(([id, s]) => ({
            id,
            actual: s.cancionActual?.titulo,
            cola: s.cola.length,
            clientes: s.clientes.length
        }))
    });
});

// ============================================
// INTERFAZ HTML
// ============================================

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🎵 Pixel Mafia - Panel + Radio</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', system-ui, sans-serif;
            background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 50%, #16213e 100%);
            color: #e0e0e0;
            min-height: 100vh;
            display: grid;
            grid-template-columns: 350px 1fr;
            grid-template-rows: auto 1fr auto;
            grid-template-areas: 
                "header header"
                "sidebar main"
                "footer footer";
        }
        header {
            grid-area: header;
            background: rgba(0,0,0,0.3);
            border-bottom: 1px solid rgba(99, 102, 241, 0.3);
            padding: 15px 25px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        h1 {
            font-size: 1.5em;
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .status-bar { display: flex; gap: 15px; }
        .status-pill {
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 500;
        }
        .status-pill.active {
            background: rgba(34, 197, 94, 0.2);
            color: #4ade80;
            border: 1px solid rgba(34, 197, 94, 0.3);
        }
        .status-pill.inactive {
            background: rgba(148, 163, 184, 0.2);
            color: #94a3b8;
            border: 1px solid rgba(148, 163, 184, 0.3);
        }
        aside {
            grid-area: sidebar;
            background: rgba(255,255,255,0.03);
            border-right: 1px solid rgba(255,255,255,0.1);
            padding: 20px;
            overflow-y: auto;
        }
        .form-group { margin-bottom: 15px; }
        label {
            display: block;
            margin-bottom: 5px;
            color: #888;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        input, select, textarea {
            width: 100%;
            padding: 10px 12px;
            background: rgba(0,0,0,0.3);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            color: #fff;
            font-size: 13px;
        }
        input:focus, select:focus, textarea:focus {
            outline: none;
            border-color: #6366f1;
        }
        textarea { min-height: 60px; resize: vertical; }
        .btn {
            width: 100%;
            padding: 12px;
            border: none;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
            margin-bottom: 8px;
        }
        .btn-primary {
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            color: white;
        }
        .btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: 0 5px 15px rgba(99, 102, 241, 0.4);
        }
        .btn-danger {
            background: rgba(239, 68, 68, 0.2);
            color: #ef4444;
            border: 1px solid rgba(239, 68, 68, 0.3);
        }
        .btn-sm { padding: 6px 12px; font-size: 11px; }
        .sala-item {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 10px;
        }
        .btn-add {
            background: rgba(255,255,255,0.1);
            color: #aaa;
            border: 1px dashed rgba(255,255,255,0.2);
        }
        main {
            grid-area: main;
            padding: 20px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }
        .section-title {
            font-size: 14px;
            color: #8b5cf6;
            margin-bottom: 15px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .bots-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
            max-height: 200px;
            overflow-y: auto;
        }
        .bot-card {
            background: rgba(99, 102, 241, 0.1);
            border: 1px solid rgba(99, 102, 241, 0.3);
            border-radius: 12px;
            padding: 15px;
        }
        .bot-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .bot-name { font-weight: 600; color: #818cf8; }
        .bot-meta {
            font-size: 12px;
            color: #666;
            margin-bottom: 10px;
        }
        .logs-container {
            background: rgba(0,0,0,0.4);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            padding: 15px;
            flex: 1;
            overflow-y: auto;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 12px;
            line-height: 1.6;
        }
        .log-entry { margin-bottom: 3px; padding: 2px 0; }
        .log-time { color: #555; margin-right: 8px; }
        .log-bot { color: #4ade80; }
        .log-error { color: #f87171; }
        .log-warn { color: #fbbf24; }
        .log-success { color: #22d3ee; }
        .log-2fa { color: #f472b6; }
        .log-info { color: #94a3b8; }
        footer {
            grid-area: footer;
            background: rgba(0,0,0,0.3);
            border-top: 1px solid rgba(255,255,255,0.1);
            padding: 10px 20px;
            font-size: 12px;
            color: #666;
            display: flex;
            justify-content: space-between;
        }
        .radio-card {
            background: rgba(139, 92, 246, 0.1);
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 12px;
            padding: 12px;
            margin-bottom: 10px;
        }
        .radio-url {
            font-size: 11px;
            color: #a78bfa;
            word-break: break-all;
            background: rgba(0,0,0,0.3);
            padding: 8px;
            border-radius: 6px;
            margin-top: 8px;
            cursor: pointer;
        }
        .radio-url:hover {
            background: rgba(139, 92, 246, 0.2);
        }
        .copy-btn {
            float: right;
            background: rgba(139,92,246,0.4);
            border: none;
            color: #e2e8f0;
            padding: 2px 6px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 10px;
        }
        .divider {
            height: 1px;
            background: rgba(255,255,255,0.1);
            margin: 15px 0;
        }
        .quick-actions { display: flex; gap: 8px; margin-top: 15px; }
        .quick-actions .btn { flex: 1; }
        .section { margin-bottom: 20px; }
    </style>
</head>
<body>
    <header>
        <h1>🎵 Pixel Mafia - Panel + Radio</h1>
        <div class="status-bar">
            <span id="statusBots" class="status-pill inactive">Bots: 0</span>
            <span id="statusRadio" class="status-pill inactive">Radio: OFF</span>
        </div>
    </header>
    
    <aside>
        <div class="section">
            <div class="section-title">⚙️ Nuevo Bot</div>
            
            <div class="form-group">
                <label>ID Bot</label>
                <input type="text" id="botId" placeholder="bot-1" value="bot-1">
            </div>
            
            <div class="form-group">
                <label>Nombre</label>
                <input type="text" id="botNombre" placeholder="DJ Pixel" value="DJ Pixel">
            </div>
            
            <div class="form-group">
                <label>Modo</label>
                <select id="botHeadless">
                    <option value="true">🔒 Headless (oculto)</option>
                    <option value="false">👁️ Con ventana</option>
                </select>
            </div>
        </div>
        
        <div class="divider"></div>
        
        <div class="section">
            <div class="section-title">🏠 Salas IMVU</div>
            <div id="salasContainer"></div>
            <button class="btn btn-add" id="btnAgregarSala">+ Agregar Sala</button>
        </div>
        
        <div class="divider"></div>
        
        <div class="form-group">
            <label>Usuario IMVU</label>
            <input type="text" id="botUsuario" placeholder="email">
        </div>
        
        <div class="form-group">
            <label>Contraseña</label>
            <input type="password" id="botPassword" placeholder="password">
        </div>
        
        <button class="btn btn-primary" id="btnIniciarBot">🚀 Iniciar Bot</button>
        
        <div class="quick-actions">
            <button class="btn btn-danger btn-sm" id="btnDetenerTodos">⏹️ Todos</button>
            <button class="btn btn-sm" id="btnGuardar" style="background: rgba(34, 197, 94, 0.2); color: #4ade80;">💾 Guardar</button>
        </div>
    </aside>
    
    <main>
        <div class="section-title">📻 Salas de Radio Activas</div>
        <div id="radioContainer" style="max-height: 150px; overflow-y: auto; margin-bottom: 15px;"></div>
        
        <div class="section-title">🤖 Bots Activos</div>
        <div id="botsContainer" class="bots-grid">
            <div style="color: #555; text-align: center; padding: 20px;">No hay bots</div>
        </div>
        
        <div class="section-title">📜 Logs</div>
        <div id="logsContainer" class="logs-container"></div>
    </main>
    
    <footer>
        <span>Pixel Mafia v3.0 | Puerto: ${PORT}</span>
        <span id="wsStatus">● Desconectado</span>
    </footer>
    
    <script>
        const ws = new WebSocket('ws://localhost:${PORT}');
        const logsContainer = document.getElementById('logsContainer');
        const botsContainer = document.getElementById('botsContainer');
        const radioContainer = document.getElementById('radioContainer');
        const statusBots = document.getElementById('statusBots');
        const statusRadio = document.getElementById('statusRadio');
        const wsStatus = document.getElementById('wsStatus');
        
        function addLogEntry(log) {
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            const colors = { bot: 'log-bot', error: 'log-error', warn: 'log-warn', success: 'log-success', '2fa': 'log-2fa', info: 'log-info' };
            const color = colors[log.tipo] || 'log-info';
            entry.innerHTML = '<span class="log-time">' + log.time + '</span><span class="' + color + '">' + escapeHtml(log.mensaje) + '</span>';
            logsContainer.appendChild(entry);
            logsContainer.scrollTop = logsContainer.scrollHeight;
            while (logsContainer.children.length > 500) logsContainer.removeChild(logsContainer.firstChild);
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        ws.onopen = () => {
            wsStatus.innerHTML = '<span style="color: #4ade80;">Conectado</span>';
        };
        
        ws.onclose = () => {
            wsStatus.innerHTML = '<span style="color: #ef4444;">Desconectado</span>';
        };
        
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            switch(msg.type) {
                case 'log':
                    addLogEntry(msg.data);
                    break;
                case 'logs':
                    logsContainer.innerHTML = '';
                    msg.data.forEach(addLogEntry);
                    break;
                case 'status':
                    updateUI(msg.data);
                    break;
            }
        };
        
        function updateUI(data) {
            // Update bots status
            const bots = data.bots || [];
            statusBots.textContent = 'Bots: ' + bots.length;
            statusBots.className = bots.length > 0 ? 'status-pill active' : 'status-pill inactive';
            
            if (bots.length === 0) {
                botsContainer.innerHTML = '<div style="color: #555; text-align: center; padding: 20px;">No hay bots</div>';
            } else {
                botsContainer.innerHTML = bots.map(b => '<div class="bot-card"><div class="bot-header"><span class="bot-name">' + b.nombre + '</span><span style="color: #4ade80;">●</span></div><div class="bot-meta">ID: ' + b.id + '<br>Salas: ' + b.salas + '<br>PID: ' + (b.pid || 'N/A') + '</div><button class="btn btn-danger btn-sm" onclick="detenerBot(\'' + b.id + '\')">Detener</button></div>').join('');
            }
            
            // Update radio status
            const radio = data.radio || [];
            statusRadio.textContent = radio.length > 0 ? 'Radio: ON (' + radio.length + ')' : 'Radio: OFF';
            statusRadio.className = radio.length > 0 ? 'status-pill active' : 'status-pill inactive';
            
            if (radio.length === 0) {
                radioContainer.innerHTML = '<div style="color: #555; text-align: center; padding: 10px;">Sin salas de radio activas</div>';
            } else {
                radioContainer.innerHTML = radio.map(r => {
                    const radioUrl = 'http://localhost:${PORT}/radio/' + r.id;
                    return '<div class="radio-card"><div style="display:flex; justify-content:space-between; align-items:center;"><span style="color:#a78bfa; font-weight:600;">' + r.id + '</span><span style="font-size:11px; color:#666;">' + (r.actual || 'Sin reproducir') + '</span></div><div style="font-size:11px; color:#666; margin-top:4px;">Cola: ' + r.cola + ' | Clientes: ' + r.clientes + '</div><div class="radio-url" onclick="copyToClipboard(\'' + radioUrl + '\')"><button class="copy-btn">📋 Copiar</button>' + radioUrl + '</div></div>';
                }).join('');
            }
        }
        
        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                alert('URL copiada: ' + text);
            });
        }
        
        function agregarSala() {
            const container = document.getElementById('salasContainer');
            const div = document.createElement('div');
            div.className = 'sala-item';
            div.innerHTML = '<input type="text" class="sala-nombre" placeholder="Nombre sala" style="margin-bottom:8px; width:100%;"><input type="url" class="sala-url" placeholder="https://go.imvu.com/chat/room-XXXXXX" style="width:calc(100% - 30px);"><button onclick="this.parentElement.remove()" style="width:24px; background:rgba(239,68,68,0.3); border:none; color:#ef4444; cursor:pointer; margin-left:6px;">×</button>';
            container.appendChild(div);
        }
        
        function obtenerSalas() {
            const salas = [];
            document.querySelectorAll('.sala-item').forEach((item, idx) => {
                const nombre = item.querySelector('.sala-nombre').value || 'Sala ' + (idx + 1);
                const url = item.querySelector('.sala-url').value;
                if (url) salas.push({ id: 'sala-' + idx, nombre, url, categoria: 'GA' });
            });
            return salas;
        }
        
        async function iniciarBot() {
            const salas = obtenerSalas();
            if (salas.length === 0) { alert('Agrega al menos una sala'); return; }
            
            const data = {
                id: document.getElementById('botId').value || 'bot-' + Date.now(),
                nombre: document.getElementById('botNombre').value,
                headless: document.getElementById('botHeadless').value === 'true',
                salas,
                usuario: document.getElementById('botUsuario').value,
                password: document.getElementById('botPassword').value,
                radioServer: 'http://localhost:${PORT}'
            };
            
            try {
                const res = await fetch('/api/bot/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const result = await res.json();
                if (!result.ok) alert('Error: ' + result.error);
                else guardarConfig();
            } catch (e) { alert('Error de conexión'); }
        }
        
        async function detenerBot(id) {
            if (!confirm('¿Detener bot ' + id + '?')) return;
            try {
                await fetch('/api/bot/stop', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                });
            } catch (e) { alert('Error'); }
        }
        
        async function detenerTodos() {
            if (!confirm('¿Detener TODOS?')) return;
            try {
                await fetch('/api/bot/stop-all', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (e) { alert('Error'); }
        }
        
        function guardarConfig() {
            const config = {
                botId: document.getElementById('botId').value,
                botNombre: document.getElementById('botNombre').value,
                botHeadless: document.getElementById('botHeadless').value,
                botUsuario: document.getElementById('botUsuario').value,
                botPassword: document.getElementById('botPassword').value,
                salas: obtenerSalas()
            };
            localStorage.setItem('pixelMafiaConfig', JSON.stringify(config));
            alert('Configuración guardada');
        }
        
        function cargarConfig() {
            try {
                const saved = localStorage.getItem('pixelMafiaConfig');
                if (!saved) return;
                const c = JSON.parse(saved);
                if (c.botId) document.getElementById('botId').value = c.botId;
                if (c.botNombre) document.getElementById('botNombre').value = c.botNombre;
                if (c.botHeadless) document.getElementById('botHeadless').value = c.botHeadless;
                if (c.botUsuario) document.getElementById('botUsuario').value = c.botUsuario;
                if (c.botPassword) document.getElementById('botPassword').value = c.botPassword;
                if (c.salas) {
                    document.getElementById('salasContainer').innerHTML = '';
                    c.salas.forEach(s => {
                        agregarSala();
                        const items = document.querySelectorAll('.sala-item');
                        const last = items[items.length - 1];
                        last.querySelector('.sala-nombre').value = s.nombre;
                        last.querySelector('.sala-url').value = s.url;
                    });
                }
            } catch (e) { console.log('Error cargando config:', e); }
        }
        
        document.addEventListener('DOMContentLoaded', () => {
            document.getElementById('btnAgregarSala').addEventListener('click', agregarSala);
            document.getElementById('btnIniciarBot').addEventListener('click', iniciarBot);
            document.getElementById('btnDetenerTodos').addEventListener('click', detenerTodos);
            document.getElementById('btnGuardar').addEventListener('click', guardarConfig);
            
            cargarConfig();
            setTimeout(() => {
                if (document.querySelectorAll('.sala-item').length === 0) agregarSala();
            }, 100);
        });
    </script>
</body>
</html>
    `);
});

// ============================================
// INICIO
// ============================================

server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}`;
    
    console.clear();
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║           🎵 Pixel Mafia - Panel + Radio v3.0             ║
║                                                          ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  🌐 Panel: ${url.padEnd(43)}  ║
║                                                          ║
║  📻 Endpoints de Radio:                                  ║
║     - /play?q=<cancion>  (Buscar y agregar)             ║
║     - /radio/<sala>      (Stream de audio)              ║
║     - /queue             (Ver cola)                     ║
║     - /skip              (Saltar canción)               ║
║                                                          ║
║  🤖 API de Bots:                                          ║
║     - POST /api/bot/start                                ║
║     - POST /api/bot/stop                                 ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`);
    
    addLog('info', `Panel iniciado en ${url}`);
    
    // Abrir navegador
    setTimeout(() => {
        const platform = os.platform();
        let cmd;
        if (platform === 'win32') cmd = `start chrome --app="${url}"`;
        else if (platform === 'darwin') cmd = `open -na "Google Chrome" --args --app="${url}"`;
        else cmd = `google-chrome --app="${url}" || chromium-browser --app="${url}"`;
        
        exec(cmd, (err) => {
            if (err) {
                if (platform === 'win32') exec(`start "${url}"`);
                else if (platform === 'darwin') exec(`open "${url}"`);
                else exec(`xdg-open "${url}"`);
            }
        });
    }, 1000);
});

// Manejar cierre
process.on('SIGINT', () => {
    console.log('\n👋 Cerrando...');
    Object.values(procesosBots).forEach(p => {
        try { p.kill('SIGTERM'); } catch (e) {}
    });
    server.close();
    process.exit(0);
});
