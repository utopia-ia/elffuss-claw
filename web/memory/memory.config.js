// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// La configuración de la memoria compartida de Elffuss: el ÚNICO sitio donde
// viven los valores de Elffuss (marca, orígenes, URL de la página almacén,
// espacio de nombres y colores). Los módulos del motor no llevan ninguno.
//
// La usan tres sitios con el mismo objeto:
//   · la página almacén (web/memory/), que es la dueña de la base de datos;
//   · Claw, que comparte origen con ella y llama al almacén en el mismo proceso;
//   · el chat de elffuss.com y Code, que la copian con su sha256 en su fichero
//     de anclaje y hablan con la página almacén por un iframe oculto.
//
// Colores: los de las apps, sin colores nuevos. «light» es la paleta del chat
// (tokens del sistema de diseño de elffuss.com) y «dark» la de Claw
// (css/modern.css). Cada app pide el esquema que le corresponde.
import { defineMemoryConfig } from '../js/engine/memory-config.js';

export default defineMemoryConfig({
  brand: { name: 'Elffuss' },
  namespace: 'elffuss-memory',
  storeUrl: 'https://claw.elffuss.com/memory/',
  apps: [
    { id: 'chat', origin: 'https://elffuss.com', label: { es: 'Chat', en: 'Chat' } },
    { id: 'claw', origin: 'https://claw.elffuss.com', label: { es: 'Claw', en: 'Claw' } },
    { id: 'code', origin: 'https://code.elffuss.com', label: { es: 'Code', en: 'Code' } },
  ],
  theme: {
    light: {
      '--mem-bg': '#ffffff', '--mem-fg': '#191b1e', '--mem-muted': '#5b6169', '--mem-accent': '#191b1e',
      '--mem-accent-fg': '#ffffff', '--mem-border': '#d7dbdf', '--mem-radius': '6px', '--mem-danger': '#b01f42',
      '--mem-font': 'system-ui, sans-serif',
    },
    dark: {
      '--mem-bg': '#303752', '--mem-fg': '#f1eff7', '--mem-muted': '#b6bccb', '--mem-accent': '#d9b27a',
      '--mem-accent-fg': '#303752', '--mem-border': '#4b5578',
    },
  },
  features: { proposals: true, projectScope: ['code'], incognito: true },
  legacy: { db: 'elffuss', store: 'memory', app: 'claw' },
});
