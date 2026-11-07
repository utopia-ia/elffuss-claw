// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// The rule that decides whether a turn gets the media tools in its prompt (media-intent.js), on a table of messages
// that must and must not get them. No browser, no model. The same test is in the chat, Claw and Code.
//
//   node tests/media-intent.test.mjs
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = ['site-chat/chat/media-intent.js', 'web/js/tools/media-intent.js'].map((p) => join(ROOT, p)).find(existsSync);
const { needsMediaTools } = await import(pathToFileURL(file).href);

// [message, options] → must get the media tools
const POSITIVE = [
  ['hazme una imagen de un zorro en la nieve'], ['Hazme un dibujo de mi perro'], ['crea una ilustración de un castillo'],
  ['genera un logo para mi panadería'], ['dibújame un gato'], ['píntame un atardecer'], ['quiero una foto de un dragón'],
  ['¿Me haces un retrato de una astronauta?'], ['necesito un icono para mi app'], ['haz un fondo de pantalla con montañas'],
  ['make me a picture of a lighthouse'], ['draw a cat wearing a hat'], ['generate an image of a red fox'],
  ['can you create an illustration of a robot'], ['I want a photo of the moon over Madrid'],
  ['compón una canción de cumpleaños'], ['hazme música tranquila para estudiar'], ['crea una melodía alegre'],
  ['genera una banda sonora épica'], ['compose a lofi song'], ['make some relaxing music'],
  ['haz un efecto de sonido de una puerta'], ['genera el sonido de una explosión'], ['create a sound effect of rain'],
  ['hazme un vídeo de una ola'], ['crea una animación de un cohete'], ['generate a short video of a waterfall'],
  ['léeme esto en voz alta: hola a todos'], ['di en voz alta buenos días'], ['read this aloud please'],
  ['say it out loud'], ['conviértelo en audio'], ['anímala'], ['animate it with an orbit'],
  ['usa img-k3x9 para el vídeo'], ['anima vid-ab23 otra vez'],
  ['anima esta foto', { hasMedia: true }], ['haz que la imagen de antes se mueva', { hasMedia: true }],
  ['¿puedes animar la primera imagen?', { hasMedia: true }], ['use the same picture again', { hasMedia: true }],
  ['qué opinas de esto', { attachments: 1 }], ['¿qué hay en esta foto?', { attachments: 1 }],
  // Typing slips on the verb, and bare requests (measured on elffuss.com, 2026-11-07).
  ['creame una imagen de malaga y paris juntas'], ['cfera una imagen de pars'], ['has una foto de un perro en la playa'],
  ['dibujme una imagen de un gato'], ['genra un dibujo de un barco'], ['hazmw un video de una ola'], ['craea una ilustración de un castillo'],
  ['cerame una foto de la alhambra'], ['geenra un logo para mi tienda'], ['mkae a picture of a lighthouse'], ['craete an image of a fox'],
  ['una imagen de Málaga y París juntas'], ['imagen de un zorro en la nieve'], ['foto de un atardecer en la playa'], ['un dibujo de un dragón'],
  ['an image of a cat wearing a hat'], ['un vídeo de un cohete despegando'],
];
// → must NOT get them
const NEGATIVE = [
  ['¿qué es una imagen ISO?'], ['cómo grabo una imagen ISO en un USB'], ['crea una imagen docker para mi app'],
  ['make a docker image for this service'], ['what is a container image'], ['haz una app de música'],
  ['crea una aplicación que muestre fotos'], ['hazme un reproductor de vídeo'], ['crea una galería de imágenes en html'],
  ['genera una función que lea un archivo de audio'], ['make a game with sound'], ['create a web page with a picture'],
  ['dibuja un círculo en el canvas'], ['draw a chart of sales'], ['draw conclusions from this data'],
  ['haz un gráfico con las ventas'], ['dibújame un diagrama de flujo'], ['la música de los 80 era mejor'],
  ['me encanta esta canción'], ['el sonido del mar me relaja'], ['busca fotos de auroras boreales'],
  ['search for pictures of cats'], ['¿cuántas fotos caben en 1 GB?'], ['léeme el archivo README'], ['lee el fichero main.js'],
  ['eso me anima mucho'], ['la voz de mi jefe me pone nervioso'], ['hazme un resumen del vídeo que vi'],
  ['hazme una lista de canciones de los Beatles'], ['crea una tabla con mis fotos favoritas'],
  ['speak to me about history'], ['what does this image processing code do'], ['optimiza las imágenes de la carpeta'],
  ['convierte este png a jpg'], ['hola, ¿qué tal?'], ['recuerda que me gusta la música clásica'],
  ['anima esta foto'], ['use the same picture again'],
  ['', { attachments: 1 }], ['', { attachments: 2 }], ['   ', { attachments: 1 }],
  ['creo que una foto vale más que mil palabras'], ['¿has visto la foto de ayer?'], ['para una imagen iso usa dd'],
  ['imagen de docker para node'], ['la cara de la foto sale borrosa'], ['cree una cuenta y subí una foto'],
  ['¿qué imagen de disco necesito?'], ['una imagen vale más que mil palabras'], ['the image is blurry'],
];

let fails = 0;
for (const [text, opts] of POSITIVE) { const r = needsMediaTools(text, opts); if (!r.media) { fails++; console.log('FAIL positive:', JSON.stringify(text), opts || ''); } }
for (const [text, opts] of NEGATIVE) { const r = needsMediaTools(text, opts); if (r.media) { fails++; console.log('FAIL negative:', JSON.stringify(text), r.why); } }
console.log(`${POSITIVE.length} positives, ${NEGATIVE.length} negatives: ${fails ? fails + ' wrong' : 'all right'}`);
process.exit(fails ? 1 : 0);
