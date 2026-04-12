# Health Center Chatbot — Cấu trúc project

## Cây thư mục

```
src/
├── agents/
│   ├── fitness.ts          ← FitnessAgent (Fami Fitness)
│   └── giaiCo.ts           ← GiaiCoAgent (Hoa Sen)
│
├── lib/
│   ├── stateMachine.ts     ← FSM: types, transitions, temperature
│   ├── classifier.ts       ← LLM classifier (emotion, intent, slots)
│   ├── prefixBuilder.ts    ← Build prefix inject vào agent
│   ├── playbook.ts         ← Sale tactics theo stage × emotion
│   └── stateStore.ts       ← Persist/load state từ Mastra storage
│
├── tools/
│   ├── media.ts            ← get-media: đọc ảnh/video từ local filesystem
│   └── qr.ts               ← get-qr: trả URL ảnh QR tĩnh
│
├── workflows/
│   └── router.ts           ← Main workflow: process → branch fitness/giai-co
│
└── config/
    └── memory.ts           ← Mastra memory config (giữ nguyên)

public/                     ← Static files — upload vào đây, không cần BE
├── media/
│   ├── fitness/
│   │   ├── gym/            ← ảnh + video khu gym
│   │   ├── yoga/           ← ảnh + video phòng yoga
│   │   ├── zumba/          ← ảnh + video phòng zumba
│   │   └── pool/           ← ảnh + video bể bơi 4 mùa
│   └── muscle-release/
│       ├── sport/          ← video giải cơ thể thao
│       ├── neck-shoulder/  ← video giải cơ đau vai gáy
│       ├── female/         ← video giải cơ nữ
│       └── general/        ← video giải cơ tổng hợp
└── qr/
    ├── fitness-qr.png      ← QR thanh toán Fami Fitness
    └── muscle-release-qr.png ← QR thanh toán Hoa Sen
```

---

## Setup static files trong Mastra (Hono)

Thêm 1 dòng vào `src/index.ts`:

```typescript
import { serveStatic } from "hono/bun"; // nếu dùng Bun
// hoặc: import { serveStatic } from "@hono/node-server/serve-static"; // nếu dùng Node

app.use("/public/*", serveStatic({ root: "./" }));
```

Sau đó file `./public/media/fitness/gym/photo1.jpg` sẽ accessible tại:
`http://localhost:4111/public/media/fitness/gym/photo1.jpg`

**Chỉ cần upload file vào đúng thư mục — bot tự đọc và gửi URL cho khách.**

---

## Tool keys — getMediaTool

| Key | Thư mục | Dùng khi |
|---|---|---|
| `fitness-gym` | `public/media/fitness/gym/` | Khách hỏi xem khu gym |
| `fitness-yoga` | `public/media/fitness/yoga/` | Khách hỏi về yoga |
| `fitness-zumba` | `public/media/fitness/zumba/` | Khách hỏi về zumba |
| `fitness-pool` | `public/media/fitness/pool/` | Khách hỏi về bể bơi |
| `mr-sport` | `public/media/muscle-release/sport/` | Khách hỏi giải cơ thể thao |
| `mr-neck-shoulder` | `public/media/muscle-release/neck-shoulder/` | Khách đau vai/cổ/gáy |
| `mr-female` | `public/media/muscle-release/female/` | Khách nữ hỏi giải cơ |
| `mr-general` | `public/media/muscle-release/general/` | Hỏi chung về quy trình |

## Tool keys — getQRTool

| Key | File | Dùng khi |
|---|---|---|
| `fitness` | `public/qr/fitness-qr.png` | Khách chốt gói Fami Fitness |
| `muscle-release` | `public/qr/muscle-release-qr.png` | Khách chốt gói Hoa Sen |

---

## Biến môi trường (.env)

```env
OPENAI_API_KEY=sk-...
BASE_URL=http://localhost:4111   # URL public của Mastra server

# Thông tin ngân hàng hiển thị kèm QR
FITNESS_BANK_INFO=Vietcombank - 1234567890 - NGUYEN VAN A
MUSCLE_RELEASE_BANK_INFO=Techcombank - 0987654321 - TRAN THI B
```

---

## Flow detection — Keywords

| Flow | Keywords trigger |
|---|---|
| `fitness` | gym, yoga, zumba, bơi, pilates, thể dục, tập luyện, hội viên, fitness, bể bơi... |
| `giai-co` | giải cơ, massage, xoa bóp, đau lưng, đau vai, đau cổ, trigger, spa, xông hơi, regenix, hoa sen... |

Nếu message không có keyword rõ → LLM classify.
