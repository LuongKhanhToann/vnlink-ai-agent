/**
 * classifierAB.ts — ĐO HEAD-TO-HEAD gpt-4o-mini vs gpt-5.4-mini cho classifier.
 *
 * Chạy CÙNG tập tin khó qua CẢ 2 model (override modelId), in bảng so sánh
 * domain/attribute/intent/slot. Mục đích: quyết "4o-mini đủ chưa hay cần nâng 5.4-mini"
 * bằng SỐ LIỆU, không cảm tính. KHÔNG đụng luồng reply.
 *
 * Chạy:  npx tsx src/mastra/scripts/classifierAB.ts
 */
import { classify, ClassifyInput } from "../lib/classifier";
import { DEFAULT_STATE, Flow, Stage, KnownInfo, IntentTopic } from "../lib/stateMachine";

const BASE = DEFAULT_STATE.knownInfo;
const ki = (o: Partial<KnownInfo> = {}): KnownInfo => ({ ...BASE, ...o });

interface Case {
  id: string;
  msg: string;
  flow: Flow;
  stage: Stage;
  known?: Partial<KnownInfo>;
  prevTopic?: IntentTopic | null;
  needFlow?: boolean;
  expect: string; // kỳ vọng (soi mắt)
}

const CASES: Case[] = [
  { id: "obj-terse", msg: "đắt thế e", flow: "fitness", stage: "negotiation", prevTopic: "price_ask_generic", expect: "objection / price_too_high" },
  { id: "multi-intent", msg: "gói nhiêu tiền với có ảnh phòng tập ko", flow: "fitness", stage: "evaluation", expect: "pricing + secondary media_request" },
  { id: "date-doi-y", msg: "à thôi dời sang chiều mai được ko", flow: "fitness", stage: "commitment", known: { preferredTime: "sáng thứ 7" }, expect: "scheduling, preferredTime→chiều mai (thay hẳn)" },
  { id: "date-refine", msg: "sáng nha", flow: "fitness", stage: "commitment", known: { preferredTime: "cuối tuần" }, expect: "preferredTime→'sáng cuối tuần' (gộp)" },
  { id: "postpartum", msg: "chị mới sinh xong tập được không", flow: "fitness", stage: "discovery", expect: "safety_concern / postpartum, honorific chị" },
  { id: "acute", msg: "em ơi anh vừa lật cổ chân chiều nay sưng đi ko nổi", flow: "giai-co", stage: "opening", expect: "safety_concern / acute_injury" },
  { id: "student", msg: "à mà e là sinh viên có giá ưu đãi ko", flow: "fitness", stage: "evaluation", expect: "pricing / ask_price_student + memberType hoc-sinh" },
  { id: "ambiguous-ok", msg: "ok", flow: "fitness", stage: "inbody", prevTopic: "intro_trai_nghiem", expect: "intent selecting (đồng ý InBody)" },
  { id: "compare-svc", msg: "gym với yoga cái nào tốt hơn", flow: "fitness", stage: "discovery", expect: "objection / compare_services, serviceType NULL" },
  { id: "corporate", msg: "bên anh là công ty muốn mua gói cho 20 nhân viên", flow: "fitness", stage: "opening", expect: "edge / corporate" },
  { id: "switch-flow", msg: "à mà dạo này hay đau vai gáy bên mình có giải cơ ko", flow: "fitness", stage: "discovery", expect: "nhận giải cơ (service_inquiry/edge), không lẫn" },
  { id: "gain-vs-muscle", msg: "a gầy quá ăn mãi ko lên, muốn tăng cân", flow: "fitness", stage: "discovery", expect: "discovery_answer goal=tang-can (KHÔNG tang-co), honorific anh" },
];

const MODELS = ["gpt-4o-mini", "gpt-5.4-mini"];

function fmt(r: any): string {
  const s = r.intentSignal;
  const dom = s ? `${s.domain}/${s.attribute ?? "-"}${s.service ? `(${s.service})` : ""}` : "NULL";
  const sec = (r.secondaryIntents ?? []).map((x: any) => `${x.domain}/${x.attribute ?? "-"}`).join("+") || "-";
  const slots = Object.entries(r.extractedSlots ?? {})
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "-";
  return `dom=${dom} | int=${r.intent} | emo=${r.emotion} | hon=${r.honorific ?? "-"} | 2nd=${sec} | slots=[${slots}]`;
}

async function run() {
  let diffs = 0;
  for (const c of CASES) {
    const base: Omit<ClassifyInput, "modelId"> = {
      message: c.msg,
      previousFlow: c.flow,
      previousStage: c.stage,
      currentKnownInfo: ki(c.known),
      needFlowClassification: c.needFlow ?? false,
      previousIntentTopic: c.prevTopic ?? null,
    };
    const [a, b] = await Promise.all(MODELS.map((m) => classify({ ...base, modelId: m })));
    const sig = (r: any) => (r.intentSignal ? `${r.intentSignal.domain}/${r.intentSignal.attribute ?? ""}` : "NULL");
    const differ = sig(a) !== sig(b);
    if (differ) diffs++;
    console.log(`\n━━ [${c.id}] "${c.msg}"`);
    console.log(`   kỳ vọng: ${c.expect}`);
    console.log(`   4o-mini : ${fmt(a)}`);
    console.log(`   5.4-mini: ${fmt(b)}   ${differ ? "⚠ KHÁC domain/attr" : "✓ trùng"}`);
  }
  console.log(`\n══ TỔNG: ${diffs}/${CASES.length} ca KHÁC nhau ở domain/attribute giữa 2 model.`);
  console.log(`   (Khác KHÔNG tự = sai — đọc cột "kỳ vọng" xem model nào đoán ĐÚNG hơn.)`);
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
