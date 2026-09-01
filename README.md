# Idol 巅峰对决 · IdolShow

内娱偶像在线单曲对决站点。选团/选人 → 单曲 32 强 PK，另有「梦回大厂」偶练神级舞台玩法。

## 功能

- **单曲对决**：网易云热门 Top50 定榜，iTunes 试听优先、网易云兜底，统一 30 秒试听
- **梦回大厂**：偶像练习生 49 个神级舞台，随机抽 32 进单败淘汰
- **排行榜**：艺人夺冠榜、单曲榜、舞台榜
- **艺人库**：内娱团体/个人，默认按网易云粉丝量排序，头像来自网易云

## 本地开发

```bash
npm install
npm run dev          # 前端 http://localhost:5173
npm run rank:dev     # 排行榜 API（默认 8789）
```

## 数据构建

```bash
npm run roster       # 拉网易云粉丝 + 合并艺人表 + 生成 hot-tops 静态包
npm run stages:build # 偶练舞台 iTunes 试听匹配
npm run build        # 生产构建
```

## 部署

Cloudflare Workers + D1。部署前在 `wrangler.jsonc` 填入 D1 `database_id`、KV `ARTIST_TOP`，并设置 `NETEASE_API_ORIGIN` secret。

```bash
npm run build
npx wrangler deploy
```

## 技术栈

Vite · Cloudflare Workers · D1 · 网易云 API（定榜/头像）· Apple iTunes（试听优先）
