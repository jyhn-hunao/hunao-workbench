# vendor · 第三方运行时

| 文件 | 来源 | 版本 | 许可 |
|---|---|---|---|
| `pixi.min.js` | `npm pixi.js` → `dist/browser/pixi.min.js` | 6.5.10 | MIT |
| `pixi-live2d-display.cubism4.min.js` | `npm pixi-live2d-display` → `dist/cubism4.min.js` | 0.4.0 | MIT |
| `live2dcubismcore.min.js` | `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` | 官方最新 | © Live2D Inc.，按 Cubism SDK 条款使用 |

加载顺序（`index.html`）：Cubism Core → PixiJS → pixi-live2d-display → `app.js`。

⛔ 不要手改这三个文件；升级等于整份替换，并重跑一次模型加载验证。
