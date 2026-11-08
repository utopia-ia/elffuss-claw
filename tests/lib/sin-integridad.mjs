// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A test that replaces a vendored module with a fake (route.fulfill) has to take that module's hash out of the page's
// import map: the browser checks it and refuses any other bytes, which is what the hash is there for
// (web/vendor/third-party/PIN.json, third-party.mjs --write-importmap). This serves index.html with those entries
// removed from `integrity`; everything else in the page is untouched.
//
//   await sinIntegridad(ctxOrPage, BASE, /@litert-lm\/core@/)
export async function sinIntegridad(target, base, re) {
  const origin = new URL(base).origin;
  await target.route((u) => u.origin === origin && (u.pathname === '/' || u.pathname === '/index.html'), async (route) => {
    const r = await route.fetch();
    const html = await r.text();
    const out = html.replace(/(<script type="importmap">)([\s\S]*?)(<\/script>)/, (_, a, json, c) => {
      const map = JSON.parse(json);
      for (const k of Object.keys(map.integrity || {})) if (re.test(k)) delete map.integrity[k];
      return a + '\n' + JSON.stringify(map, null, 2) + '\n' + c;
    });
    await route.fulfill({ response: r, body: out });
  });
}
