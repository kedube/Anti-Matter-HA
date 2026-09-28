# zxing-wasm (reader build), vendored

Offline QR decoding for the Anti-Matter scanner (`static/brand/js/scan-worker.js`).
Nothing is fetched from a CDN: the worker points zxing-wasm's `locateFile` at the
`.wasm` next to this file, resolved relative to the worker URL, so it works under
Home Assistant ingress (`/api/hassio_ingress/<token>/`).

| File | Source (npm `zxing-wasm@3.1.4`, published 2026-09-10) | SHA-256 |
|---|---|---|
| `zxing-reader.iife.js` | `dist/iife/reader/index.js` (global `ZXingWASM`) | `d33d09ce132a692faffbed0dce656c36cb2573b4b843885a6e036390d1071d95` |
| `zxing_reader.wasm` | `dist/reader/zxing_reader.wasm` | `e8af31edb56d0522f4de74495839385ef019ba8bc90d38e5ecb2f18795d86fb2` (matches `ZXING_WASM_SHA256` in the JS) |
| `LICENSE` | zxing-wasm package `LICENSE` (MIT, (c) 2023 Ze-Zheng Wu) | |
| `LICENSE.zxing-cpp` | zxing-cpp `LICENSE` at commit `0b2d9a8fc81f420f369928c24331091ff0525976` (Apache-2.0) | |

- zxing-wasm: https://github.com/Sec-ant/zxing-wasm (MIT). The JS glue and build scripts.
- zxing-cpp: https://github.com/zxing-cpp/zxing-cpp (Apache-2.0). The `.wasm` is compiled
  from it (`ZXING_CPP_COMMIT` = `0b2d9a8fc81f420f369928c24331091ff0525976`).

Files are byte-identical to the npm tarball; do not edit them. To upgrade:

```sh
npm pack zxing-wasm@<version>
tar xzf zxing-wasm-<version>.tgz
cp package/dist/iife/reader/index.js zxing-reader.iife.js
cp package/dist/reader/zxing_reader.wasm zxing_reader.wasm
cp package/LICENSE LICENSE
# LICENSE.zxing-cpp: zxing-cpp LICENSE at the new ZXING_CPP_COMMIT (grep the JS for it)
```

Then bump `ZXING_VERSION` in `static/brand/js/scan-worker.js` (it versions the wasm URL
as a cache-buster, because the add-on only sends `no-cache` for js/css/html/json).
