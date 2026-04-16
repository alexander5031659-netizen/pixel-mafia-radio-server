#!/bin/bash
# Build script for Render

echo "🎵 Instalando dependencias de Node.js..."
npm install

echo "🎵 Instalando yt-dlp..."
pip install yt-dlp

echo "🎵 Instalando librespot..."
# Crear directorio para binarios
mkdir -p bin

# Descargar librespot pre-compilado (versión estática)
cd bin
wget -q https://github.com/librespot-org/librespot/releases/latest/download/librespot-linux-amd64 -O librespot
chmod +x librespot

echo "✅ librespot instalado"
ls -la librespot

cd ..

echo "🎵 Build completado!"
