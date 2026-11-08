# vendor

本地内置的 Three.js，不联网、不走 CDN。

- 版本：`three@0.180.0`
- 文件：`three.module.min.js`（入口）+ `three.core.min.js`（入口内部 import 的 core）
- 许可：MIT，见 `THREE-LICENSE.txt`

升级时两个 JS 文件必须一起替换；只换 `three.module.min.js` 会一直停在加载页。
