/**
 * Auto-test kịch bản Fami Fitness (gpt-4o-mini).
 *
 * MỤC TIÊU: Bot phải trả lời "giống ý" với kịch bản trong tài liệu khách gửi.
 * Không yêu cầu giống y nguyên câu từ. Match theo KEY IDEAS:
 *   - keyword (case-insensitive, không dấu): list cụm từ; ANY-match là OK
 *   - LLM judge fallback (gpt-4o-mini): nếu keyword miss, hỏi judge xem ý có trùng không
 *
 * Run:
 *   $env:STORAGE_BACKEND="libsql"; npx tsx src/mastra/scripts/testKichBanAuto.ts
 *
 * Exit code: 0 = pass tất cả, 1 = còn turn fail.
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = "libsql";

import { Agent } from "@mastra/core/agent";
import { z } from "zod";

const { mastra } = await import("../index");
const { routerWorkflow } = await import("../workflows/routerWorkflow");
const { loadState } = await import("../lib/stateStore");
const { chatModel } = await import("../config/openai");

// ─────────────────────────────────────────────
// HELPER: normalize tiếng Việt (bỏ dấu + lowercase) — phục vụ keyword match
// ─────────────────────────────────────────────
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

// ─────────────────────────────────────────────
// TYPE: 1 key idea = list các alt phrase (bot reply chỉ cần chứa 1 trong số đó)
// ─────────────────────────────────────────────
interface KeyIdea {
  label: string;          // tên ý chính (in log)
  anyOf: string[];        // các keyword phrase (chứa ANY = đạt)
  semantic?: string;      // mô tả ý cho LLM judge nếu keyword miss
}

interface ExpectedTurn {
  customer: string;
  ideas: KeyIdea[];
  // optional: ideas mà bot KHÔNG được nói (negative match)
  notIdeas?: KeyIdea[];
}

interface Scenario {
  name: string;
  turns: ExpectedTurn[];
}

// ─────────────────────────────────────────────
// SCENARIOS — extract từ tài liệu KH gửi
// ─────────────────────────────────────────────

const GREETING_IDEA: KeyIdea = {
  label: "Lời chào mở đầu",
  anyOf: ["em chao", "chao anh", "chao chi", "cam on anh", "cam on chi"],
  semantic: "Lời chào mở đầu thân thiện, cảm ơn khách đã quan tâm",
};

const ASK_BO_MON_IDEA: KeyIdea = {
  label: "Hỏi bộ môn quan tâm",
  anyOf: ["quan tam den bo mon", "bo mon nao", "quan tam bo mon", "mon nao de em"],
  semantic: "Hỏi khách đang quan tâm đến bộ môn nào (gym/yoga/zumba/bơi)",
};

const SCENARIOS: Scenario[] = [
  // ═══ CƠ BẢN ═══
  {
    name: "01_quan_tam",
    turns: [
      {
        customer: "Quan tâm",
        ideas: [GREETING_IDEA, ASK_BO_MON_IDEA],
      },
    ],
  },
  {
    name: "02_tap_trai_nghiem",
    turns: [
      {
        customer: "Tôi muốn tập trải nghiệm",
        ideas: [
          GREETING_IDEA,
          {
            label: "Hỏi bộ môn / giờ tập",
            anyOf: [
              "bo mon nao",
              "khung gio nao",
              "co the di tap",
              "5h",
              "20h30",
              "gym, yoga",
            ],
            semantic: "Hỏi khách quan tâm bộ môn nào, hoặc khung giờ tập, hoặc list dịch vụ",
          },
        ],
      },
    ],
  },
  {
    name: "03_giam_can",
    turns: [
      {
        customer: "Tôi muốn tập giảm cân",
        ideas: [
          GREETING_IDEA,
          {
            label: "Hỏi history giảm cân / tập luyện hiện tại",
            anyOf: [
              "dang tap luyen",
              "bien phap giam can",
              "tap luyen hay su dung",
              "giam can nao khong",
            ],
            semantic: "Hỏi khách có đang tập luyện hay dùng biện pháp giảm cân nào không",
          },
        ],
      },
    ],
  },
  {
    name: "04_chuong_trinh_tap",
    turns: [
      {
        customer: "Tư vấn cho tôi về chương trình tập luyện",
        ideas: [
          GREETING_IDEA,
          {
            label: "List 4 dịch vụ",
            anyOf: ["gym", "yoga", "zumba", "boi"],
            semantic: "Có nhắc đến các bộ môn Gym, Yoga, Zumba, Bơi",
          },
          ASK_BO_MON_IDEA,
        ],
      },
    ],
  },
  {
    name: "05_uu_dai",
    turns: [
      {
        customer: "có chương trình ưu đãi nào không?",
        ideas: [
          GREETING_IDEA,
          {
            label: "Có nhắc ưu đãi / list dịch vụ / hỏi bộ môn",
            anyOf: [
              "uu dai",
              "333k",
              "5h",
              "20h30",
              "bo mon nao",
            ],
            semantic: "Đề cập ưu đãi (từ 333k/tháng), giờ mở cửa, hoặc hỏi bộ môn để tư vấn ưu đãi",
          },
        ],
      },
    ],
  },

  // ═══ HỌC BƠI TRẺ EM ═══
  {
    name: "06_hoc_boi_tre_em",
    turns: [
      {
        customer: "Quan tâm học bơi",
        ideas: [
          {
            label: "Hỏi người lớn hay trẻ em",
            anyOf: ["nguoi lon hay tre em", "nguoi lon", "tre em", "be hay nguoi lon"],
            semantic: "Hỏi khách quan tâm học bơi cho người lớn hay trẻ em",
          },
        ],
      },
      {
        customer: "Quan tâm học bơi cho trẻ em",
        ideas: [
          {
            label: "Nhận từ 6 tuổi",
            anyOf: ["6 tuoi", "tu 6t", "tu 6 tuoi"],
            semantic: "Bên em nhận học sinh từ 6 tuổi",
          },
          {
            label: "Hỏi tuổi bé",
            anyOf: ["may tuoi", "bao nhieu tuoi", "tuoi roi"],
            semantic: "Hỏi bé nhà mình năm nay mấy tuổi",
          },
        ],
      },
      {
        customer: "cháu 6 tuổi em nhé",
        ideas: [
          {
            label: "Test nước / bạo nước",
            anyOf: ["test nuoc", "bao nuoc", "voi sen", "ngup nuoc", "dam nuoc"],
            semantic: "Đề cập test nước, mức độ bạo nước, hỏi bé có tắm vòi sen hay ngụp nước được không",
          },
        ],
      },
    ],
  },

  // ═══ YOGA FLOW ═══
  {
    name: "07_yoga_full",
    turns: [
      {
        customer: "Quan tâm Yoga",
        ideas: [
          {
            label: "Hỏi đã tập yoga chưa",
            anyOf: ["da tap yoga chua", "tap yoga bao gio chua", "truoc day", "da tung tap"],
            semantic: "Hỏi khách trước đây đã tập yoga chưa",
          },
        ],
      },
      {
        customer: "chị chưa tập, có lớp cho người mới không em?",
        ideas: [
          {
            label: "Trấn an có lớp/HLV hỗ trợ",
            anyOf: [
              "lop cong dong",
              "lop cho nguoi moi",
              "hlv",
              "huan luyen vien",
              "giao vien",
              "ho tro",
              "yen tam",
            ],
            semantic: "Trấn an khách: có lớp cộng đồng cho người mới, HLV/giáo viên hỗ trợ, yên tâm tập được",
          },
        ],
      },
      {
        customer: "Bao nhiêu tiền/tháng em?",
        ideas: [
          {
            label: "Báo giá yoga",
            anyOf: ["350k", "tu 350", "/thang", "uu dai"],
            semantic: "Báo giá yoga (từ 350k/tháng) hoặc đề cập ưu đãi",
          },
          {
            label: "Mời trải nghiệm",
            anyOf: ["trai nghiem", "tap thu", "thu 1 buoi", "buoi thu"],
            semantic: "Mời khách đăng ký trải nghiệm/tập thử trước",
          },
        ],
      },
      {
        customer: "ĐK trải nghiệm như thế nào?",
        ideas: [
          {
            label: "Xin SĐT + khung giờ",
            anyOf: ["sdt", "so dien thoai", "khung gio", "lich tap", "gio tap"],
            semantic: "Xin SĐT và khung giờ tập của khách để đăng ký trải nghiệm",
          },
        ],
      },
      {
        customer: "thủy 0929229291",
        ideas: [
          {
            label: "Hỏi/xác nhận khung giờ — KHÔNG hỏi lại đã tập yoga chưa",
            anyOf: ["khung gio", "buoi sang", "sang", "chieu", "toi", "tien gio nao", "giu slot", "thuy"],
            semantic: "Sau khi khách cho tên+SĐT, bot phải hỏi khung giờ hoặc xác nhận slot, KHÔNG được hỏi lại 'đã tập yoga chưa'",
          },
        ],
        notIdeas: [
          {
            label: "KHÔNG re-ask discovery 'đã tập yoga chưa'",
            anyOf: ["da tap yoga chua", "tap yoga bao gio chua", "tap yoga chua a"],
            semantic: "Bot KHÔNG được hỏi lại câu discovery sau khi đã có tên+SĐT",
          },
        ],
      },
      {
        customer: "8h sáng mai",
        ideas: [
          {
            label: "Chốt slot — giữ slot + hẹn gặp",
            anyOf: ["giu slot", "hen gap", "8h", "sang mai"],
            semantic: "Bot xác nhận đã giữ slot 8h sáng mai cho khách thủy, hẹn gặp",
          },
        ],
        notIdeas: [
          {
            label: "KHÔNG hỏi lại tên/SĐT/giờ đã có",
            anyOf: ["cho em xin ten", "cho em xin sdt", "cho em xin so dien thoai"],
            semantic: "Bot KHÔNG hỏi lại tên/SĐT đã có trong KNOWN",
          },
        ],
      },
    ],
  },

  // ═══ ZUMBA ═══
  {
    name: "08_zumba_full",
    turns: [
      {
        customer: "Quan tâm zumba",
        ideas: [
          {
            label: "Hỏi đã tập zumba chưa",
            anyOf: ["da tap zumba chua", "tap zumba bao gio chua", "truoc day", "da tung tap"],
            semantic: "Hỏi khách trước đây đã tập zumba chưa",
          },
        ],
      },
      {
        customer: "chị chưa tập, có lớp cho người mới không em?",
        ideas: [
          {
            label: "Trấn an / có lớp người mới",
            anyOf: ["yen tam", "khong theo duoc", "ho tro", "co giao", "huong dan", "ren luyen"],
            semantic: "Trấn an khách yên tâm, có lớp/cô giáo hỗ trợ người mới",
          },
        ],
      },
      {
        customer: "Tập Zumba có giảm cân không?",
        ideas: [
          {
            label: "Xác nhận có giảm cân/giảm mỡ",
            anyOf: ["giam mo", "giam can", "san chac", "dot calo"],
            semantic: "Xác nhận zumba giúp giảm mỡ toàn thân, săn chắc cơ thể, đốt calo",
          },
        ],
      },
      {
        customer: "Ừ, chị đang có nhu cầu Giảm cân, chị thấy mọi người bảo giảm cân nên tập Aerobic",
        ideas: [
          {
            label: "So sánh Zumba vs Aerobic",
            anyOf: ["aerobic", "nhay", "nen nhac", "manh me", "cam thu am nhac", "uyen chuyen"],
            semantic: "So sánh Zumba và Aerobic — đều tập trên nền nhạc, Zumba thiên về nhảy/cảm thụ âm nhạc, đa dạng hơn Aerobic",
          },
        ],
      },
      {
        customer: "Có được tập thử không?",
        ideas: [
          {
            label: "Có tập thử / mời thử 1 buổi",
            anyOf: ["tap thu", "trai nghiem", "1 buoi", "thu 1 buoi"],
            semantic: "Có hỗ trợ tập thử / mời thử 1 buổi xem có phù hợp không",
          },
        ],
      },
      {
        customer: "Chị đi được, thế có những gói giá nào thế em? chị chưa tập bao giờ",
        ideas: [
          {
            label: "List gói giá",
            anyOf: ["6 thang", "12 thang", "375k", "/thang", "goi"],
            semantic: "Liệt kê các gói giá (6-12 tháng) hoặc giá ưu đãi từ 375k/tháng",
          },
        ],
      },
      {
        customer: "ok chị lấy gói 6 tháng, mai chị qua thử",
        ideas: [
          {
            label: "Xin tên + SĐT để đăng ký",
            anyOf: ["ten", "sdt", "so dien thoai", "ho ten", "thong tin"],
            semantic: "Bot xin tên và SĐT để hoàn tất đăng ký",
          },
        ],
      },
      {
        customer: "thủy 0929229291",
        ideas: [
          {
            label: "Hỏi khung giờ / xác nhận — KHÔNG re-ask discovery",
            anyOf: ["khung gio", "sang", "chieu", "toi", "tien gio nao", "giu slot"],
            semantic: "Bot hỏi khung giờ hoặc xác nhận slot (KH đã cho tên+SĐT)",
          },
        ],
        notIdeas: [
          {
            label: "KHÔNG re-ask 'đã tập zumba chưa'",
            anyOf: ["da tap zumba chua", "tap zumba bao gio chua"],
            semantic: "Bot KHÔNG được hỏi lại discovery",
          },
        ],
      },
      {
        customer: "7h sáng mai",
        ideas: [
          {
            label: "Chốt slot — giữ slot + hẹn gặp",
            anyOf: ["giu slot", "hen gap", "7h", "sang mai"],
            semantic: "Bot xác nhận đã giữ slot 7h sáng mai cho khách thủy, hẹn gặp",
          },
        ],
      },
    ],
  },

  // ═══ BƠI FAQ ═══
  {
    name: "09_boi_faq",
    turns: [
      {
        customer: "Bể bơi mở cửa mấy giờ?",
        ideas: [
          {
            label: "Giờ mở bể",
            anyOf: ["6h", "20h", "sang den 20", "be boi", "mo cua"],
            semantic: "Bể bơi mở cửa từ 6h sáng đến 20h",
          },
        ],
      },
      {
        customer: "Nước bể có ấm không em? Bể trong nhà hay ngoài trời?",
        ideas: [
          {
            label: "Bể 4 mùa / mái che / nước ấm",
            anyOf: ["4 mua", "bon mua", "mai che", "nuoc am", "trong nha"],
            semantic: "Bể 4 mùa, có mái che, mùa đông có nước ấm",
          },
        ],
      },
      {
        customer: "Có nhất thiết phải mặc đồ bơi không?",
        ideas: [
          {
            label: "Khuyến khích mặc đồ bơi",
            anyOf: ["khuyen khich", "bao ve", "do boi", "khong bat buoc", "ve sinh"],
            semantic: "Không bắt buộc 100% nhưng khuyến khích mặc đồ bơi để bảo vệ bản thân, vệ sinh chung",
          },
        ],
      },
      {
        customer: "Bể bơi có clo không?",
        ideas: [
          {
            label: "Có dùng clo tiêu chuẩn",
            anyOf: ["co su dung", "tieu chuan", "khu khuan", "clo", "do chi so", "an toan"],
            semantic: "Có sử dụng clo ở mức tiêu chuẩn để khử khuẩn, đo chỉ số hàng ngày",
          },
        ],
        notIdeas: [
          {
            label: "KHÔNG được nói không dùng clo",
            anyOf: ["khong dung clo", "khong co clo"],
            semantic: "Bot KHÔNG được nói bể không dùng clo",
          },
        ],
      },
    ],
  },

  // ═══ FULL DỊCH VỤ ═══
  {
    name: "10_full_chua_biet",
    turns: [
      {
        customer: "Em ơi chị đang chưa biết tập gì, em cho chị tham khảo",
        ideas: [
          {
            label: "Hỏi đã tập bộ môn nào chưa / yêu thích",
            anyOf: ["da tung tap", "bo mon nao chua", "yeu thich", "da tap bo mon"],
            semantic: "Hỏi khách trước đây đã từng tập bộ môn nào chưa hoặc có bộ môn yêu thích nào không",
          },
        ],
      },
      {
        customer: "Chị không, chị đi qua tham quan thôi. Em hỗ trợ các gói cho chị",
        ideas: [
          {
            label: "List 4 dịch vụ",
            anyOf: ["gym", "yoga", "zumba", "boi"],
            semantic: "Liệt kê 4 dịch vụ (Gym, Yoga, Zumba, Bơi)",
          },
          {
            label: "Gói Full / tổ hợp",
            anyOf: ["goi full", "to hop", "ket hop", "ca 4", "tat ca 4", "4 dich vu"],
            semantic: "Đề cập gói Full / tổ hợp đa năng bao gồm cả 4 dịch vụ",
          },
        ],
      },
      {
        customer: "Chị đang béo quá, muốn giảm cân",
        ideas: [
          {
            label: "Recommend Gym + Zumba (+ Bơi)",
            anyOf: ["gym", "zumba", "boi"],
            semantic: "Recommend kết hợp Gym + Zumba (có thể thêm Bơi) để giảm cân — đốt calo + săn chắc",
          },
        ],
      },
      {
        customer: "Thế nếu sau khi giảm cân rồi, muốn tập duy trì thì sao? Thỉnh thoảng chị cũng hay mất ngủ",
        ideas: [
          {
            label: "Thêm Yoga thư giãn / ngủ ngon",
            anyOf: ["yoga", "thu gian", "ngu ngon", "giam cang thang"],
            semantic: "Thêm Yoga thư giãn, giảm căng thẳng, ngủ ngon hơn",
          },
        ],
      },
      {
        customer: "Chị chưa tập gì đâu, nên cho chị hỏi có ai hướng dẫn không?",
        ideas: [
          {
            label: "Có HLV hỗ trợ",
            anyOf: ["hlv", "huan luyen vien", "ho tro", "huong dan", "giao vien"],
            semantic: "Có HLV/giáo viên hỗ trợ cho người mới, yên tâm",
          },
        ],
      },
      {
        customer: "Thế này chị đăng kí gói Full nhỉ?",
        ideas: [
          {
            label: "Đồng ý / confirm gói Full phù hợp",
            anyOf: ["goi full", "phu hop", "tap tat", "moi thoi diem", "muc tieu khac nhau"],
            semantic: "Đồng ý gói Full phù hợp, vì khách chưa biết tập gì nên tập tất / mỗi thời điểm 1 mục tiêu",
          },
        ],
      },
      {
        customer: "thủy 0929229291",
        ideas: [
          {
            label: "Hỏi khung giờ / xác nhận — KHÔNG re-ask discovery",
            anyOf: ["khung gio", "sang", "chieu", "toi", "tien gio nao", "giu slot"],
            semantic: "Bot hỏi khung giờ hoặc xác nhận slot",
          },
        ],
        notIdeas: [
          {
            label: "KHÔNG re-ask discovery 'đã tập bộ môn nào chưa'",
            anyOf: ["da tap bo mon nao", "da tung tap", "yeu thich bo mon"],
            semantic: "Bot KHÔNG được hỏi lại discovery sau khi đã có tên+SĐT",
          },
        ],
      },
      {
        customer: "buổi tối nha em",
        ideas: [
          {
            label: "Chốt slot — giữ slot + hẹn gặp",
            anyOf: ["giu slot", "hen gap", "toi", "thuy"],
            semantic: "Bot xác nhận đã giữ slot buổi tối cho khách thủy, hẹn gặp",
          },
        ],
      },
    ],
  },

  // ═══ CONTINUOUS-THREAD: mô phỏng KH thật chat liên tục ═══
  // Reproduce bug user thấy: T1 "Quan tâm", T2 "Tôi muốn tập trải nghiệm" cùng thread —
  // bot ở T2 dễ hỏi gộp 2 câu hỏi liền nhau, hoặc thiếu dấu chấm.
  {
    name: "00_continuous_quan_tam_trai_nghiem",
    turns: [
      {
        customer: "Quan tâm",
        ideas: [GREETING_IDEA, ASK_BO_MON_IDEA],
      },
      {
        customer: "Tôi muốn tập trải nghiệm",
        ideas: [
          {
            label: "Hỏi đúng 1 thông tin tiếp theo",
            anyOf: [
              "bo mon nao",
              "muc tieu",
              "khung gio",
            ],
            semantic:
              "Hỏi tiếp 1 thông tin DUY NHẤT (bộ môn / mục tiêu / khung giờ). KHÔNG hỏi gộp 2 câu trong 1 tin.",
          },
        ],
      },
    ],
  },

  // ═══ GYM FLOW ═══
  {
    name: "11_gym_full",
    turns: [
      {
        customer: "Tôi quan tâm đến tập gym",
        ideas: [
          {
            label: "Hỏi đã tập gym chưa",
            anyOf: ["da tap gym chua", "tap gym bao gio chua", "tap gym bao gio"],
            semantic: "Hỏi khách đã tập gym bao giờ chưa",
          },
        ],
      },
      {
        customer: "chưa, tôi chưa tập bao giờ",
        ideas: [
          {
            label: "Hỏi mục tiêu",
            anyOf: ["muc tieu", "tang can", "giam can", "duy tri", "tang co"],
            semantic: "Hỏi mục tiêu tập gym (tăng cân/giảm cân/duy trì sức khoẻ)",
          },
        ],
        notIdeas: [
          {
            label: "KHÔNG hỏi schedule khi chưa biết mục tiêu",
            anyOf: ["khung gio nao", "tien sang hay chieu", "may buoi"],
            semantic: "Bot phải hỏi mục tiêu trước (theo TL Fami), KHÔNG nhảy thẳng schedule",
          },
        ],
      },
      {
        customer: "tăng cơ",
        ideas: [
          {
            label: "Recommend PT 1-1 / Pitch gym tăng cơ",
            anyOf: ["pt", "ca nhan", "1-1", "ky thuat", "tap thu", "trai nghiem", "inbody", "khung gio"],
            semantic: "Bot recommend PT cá nhân 1-1 hoặc mời tập thử / hỏi khung giờ",
          },
        ],
      },
      {
        customer: "thủy 0929229291",
        ideas: [
          {
            label: "Hỏi khung giờ / xác nhận — KHÔNG re-ask discovery",
            anyOf: ["khung gio", "sang", "chieu", "toi", "tien gio nao", "giu slot"],
            semantic: "Bot hỏi khung giờ hoặc xác nhận slot (KH đã cho tên+SĐT)",
          },
        ],
        notIdeas: [
          {
            label: "KHÔNG re-ask 'đã tập gym chưa'",
            anyOf: ["da tap gym chua", "tap gym bao gio chua"],
            semantic: "Bot KHÔNG được hỏi lại discovery",
          },
        ],
      },
      {
        customer: "chiều 17h",
        ideas: [
          {
            label: "Chốt slot — giữ slot + hẹn gặp",
            anyOf: ["giu slot", "hen gap", "17h", "chieu", "thuy"],
            semantic: "Bot xác nhận đã giữ slot 17h chiều cho khách thủy, hẹn gặp",
          },
        ],
      },
    ],
  },

  // ═══ GYM — KH đã tập rồi (off-script branch của TL1) ═══
  {
    name: "12_gym_da_tap_roi",
    turns: [
      {
        customer: "chị đăng kí tập gym",
        ideas: [
          {
            label: "Hỏi đã tập gym chưa",
            anyOf: ["da tap gym chua", "tap gym bao gio chua", "tap gym bao gio"],
            semantic: "Bot hỏi khách đã tập gym bao giờ chưa",
          },
        ],
      },
      {
        customer: "mình từng đi rồi",
        ideas: [
          {
            label: "Hỏi mục tiêu (TL2 Fami)",
            anyOf: ["muc tieu", "tang can", "giam can", "duy tri"],
            semantic: "Theo TL Fami, sau khi KH trả lời 'đã tập rồi', bot phải hỏi mục tiêu (tăng cân/giảm cân/duy trì)",
          },
        ],
        notIdeas: [
          {
            label: "KHÔNG nhảy thẳng schedule",
            anyOf: ["khung gio nao", "tien sang hay chieu", "may buoi"],
            semantic: "Bot KHÔNG được bỏ qua câu hỏi mục tiêu để hỏi schedule",
          },
        ],
      },
    ],
  },

  // ═══ OFF-SCRIPT — KH hỏi giờ mở cửa sau khi bot pitch InBody ═══
  // Repro bug user thấy: bot trả lời lệch tùm lum (list 3 gói) khi KH hỏi câu logistics.
  {
    name: "13_inbody_then_hours_question",
    turns: [
      {
        customer: "chị đăng kí tập gym",
        ideas: [
          {
            label: "Hỏi đã tập gym chưa",
            anyOf: ["da tap gym chua", "tap gym bao gio chua"],
            semantic: "Bot hỏi đã tập gym chưa",
          },
        ],
      },
      {
        customer: "đã tập rồi",
        ideas: [
          {
            label: "Hỏi mục tiêu",
            anyOf: ["muc tieu", "tang can", "giam can", "duy tri"],
            semantic: "Hỏi mục tiêu",
          },
        ],
      },
      {
        customer: "giảm cân",
        ideas: [
          {
            label: "Tiếp tục discovery hoặc pitch InBody/schedule",
            anyOf: ["khung gio", "sang", "chieu", "inbody", "may buoi", "buoi nao", "ket hop", "zumba", "boi"],
            semantic: "Bot hỏi schedule hoặc gợi giải pháp giảm cân (Gym+Zumba+Bơi) hoặc pitch InBody",
          },
        ],
      },
      {
        customer: "chị có thể qua lúc nào",
        ideas: [
          {
            label: "Trả giờ mở cửa 5h-20h30 + hỏi sáng/chiều",
            anyOf: ["5h", "20h30", "5 gio", "20h", "mo cua", "hang ngay"],
            semantic: "Bot trả giờ mở cửa của trung tâm (5h-20h30) và hỏi khách tiện sáng hay chiều",
          },
        ],
        notIdeas: [
          {
            label: "KHÔNG list 3 gói khi KH chỉ hỏi giờ",
            anyOf: [
              "fulltime 12 thang 5",
              "3 buoi/tuan 12 thang 4.5",
              "pt 20 buoi",
              "7 trieu",
              "5 trieu",
              "4.5 trieu",
            ],
            semantic: "Bot KHÔNG được list 3 gói tập / giá tiền khi KH chỉ hỏi giờ mở cửa",
          },
        ],
      },
    ],
  },

  // ═══ OFF-SCRIPT — KH hỏi giờ ngay từ đầu ═══
  {
    name: "14_hours_question_first_turn",
    turns: [
      {
        customer: "trung tâm mở mấy giờ vậy em",
        ideas: [
          {
            label: "Trả giờ mở cửa",
            anyOf: ["5h", "20h30", "20h", "mo cua", "hang ngay"],
            semantic: "Bot trả giờ mở cửa của trung tâm",
          },
        ],
        notIdeas: [
          {
            label: "KHÔNG list gói",
            anyOf: ["7 trieu", "5 trieu", "fulltime 12 thang"],
            semantic: "Bot KHÔNG list giá gói",
          },
        ],
      },
    ],
  },
];

// ─────────────────────────────────────────────
// LLM JUDGE — fallback nếu keyword miss
// ─────────────────────────────────────────────
const judgeAgent = new Agent({
  name: "kichban-judge",
  id: "kichban-judge",
  model: chatModel,
  instructions:
    "Bạn là chuyên gia review chatbot tiếng Việt. " +
    "Kiểm tra xem reply có chứa 1 ý chính cho trước hay không. Trả về JSON.",
});

const judgeSchema = z.object({
  match: z.boolean().describe("true nếu reply có chứa ý chính (kể cả paraphrase), false nếu không"),
  reason: z.string().describe("Lý do ngắn gọn dưới 30 từ"),
});

async function judgeIdea(reply: string, idea: KeyIdea): Promise<{ match: boolean; reason: string }> {
  try {
    const result = await judgeAgent.generate(
      `REPLY BOT: """${reply}"""\n\n` +
        `Ý CHÍNH cần check (theo kịch bản): "${idea.semantic ?? idea.label}"\n\n` +
        `CHẤM CHẶT — chỉ trả true khi reply THỰC SỰ thực hiện đúng ý này, không chỉ contain vài từ giống.\n` +
        `Cụ thể:\n` +
        `- Nếu ý là "hỏi X" thì reply phải có CÂU HỎI rõ ràng về X, không chỉ MENTION X.\n` +
        `- Nếu ý là "trả lời X có/không" thì reply phải có câu khẳng định/phủ định.\n` +
        `- Nếu ý là "list 4 dịch vụ" thì reply phải LIST đủ 4, không thiếu môn nào.\n` +
        `- Nếu reply có nhiều câu hỏi mà chỉ 1 câu khớp ý → vẫn fail (vì bot vi phạm rule 1 Q/reply).\n` +
        `Trả JSON {match: true/false, reason ngắn gọn dưới 30 từ}.`,
      {
        structuredOutput: {
          schema: judgeSchema,
          instructions: "Trả đúng schema.",
        },
      },
    );
    if (!result.object) throw new Error("no object");
    return result.object;
  } catch (e) {
    return { match: false, reason: `judge error: ${String(e).slice(0, 60)}` };
  }
}

function keywordMatch(reply: string, idea: KeyIdea): boolean {
  const norm = normalize(reply);
  return idea.anyOf.some((kw) => norm.includes(normalize(kw)));
}

interface TurnReport {
  turn: number;
  customer: string;
  reply: string;
  passes: { label: string; method: "keyword" | "judge" | "miss"; reason?: string }[];
  fails: { label: string; reason: string }[];
  negativeFails: { label: string; matched: string }[];
  styleFails: string[];
}

// Deterministic style checks: thiếu dấu chấm giữa 2 câu, > 1 câu hỏi/reply, vv.
function deterministicStyleCheck(reply: string): string[] {
  const issues: string[] = [];
  if (!reply || !reply.trim()) {
    issues.push("Reply rỗng");
    return issues;
  }

  // 1. Số câu hỏi (rule fitness.ts: mỗi tin ≤1 câu hỏi)
  const qCount = (reply.match(/[?？]/g) || []).length;
  if (qCount > 1) {
    issues.push(`${qCount} câu hỏi trong 1 reply (max 1)`);
  }

  // 2. Thiếu dấu chấm giữa 2 câu (sentence A kết "ạ"/"."/"!" rồi viết hoa mà không có dấu)
  // Pattern: lowercase/space + "ạ" / "rồi" / số + WHITESPACE + capital letter (không phải tiếp nối)
  // Vd: "...chưa ạ Mục tiêu..." → chỗ "ạ M" thiếu dấu chấm
  // Detect: " ạ " followed by capital letter without intermediate punctuation
  if (/\bạ\s+[A-ZĐĂÂÊÔƠƯÁÀẢÃẠÉÈẺẼẸÍÌỈĨỊÓÒỎÕỌÚÙỦŨỤÝỲỶỸỴ]/.test(reply)) {
    const m = reply.match(/\bạ\s+([A-ZĐĂÂÊÔƠƯÁÀẢÃẠÉÈẺẼẸÍÌỈĨỊÓÒỎÕỌÚÙỦŨỤÝỲỶỸỴ][a-zàáảãạăâđèéẻẽẹêìíỉĩịòóỏõọôơùúủũụưỳýỷỹỵ]{1,15})/);
    issues.push(`Thiếu dấu "." giữa "ạ" và câu mới: "ạ ${m?.[1]}..."`);
  }

  return issues;
}

async function checkTurn(reply: string, expected: ExpectedTurn): Promise<{
  passes: TurnReport["passes"];
  fails: TurnReport["fails"];
  negativeFails: TurnReport["negativeFails"];
  styleFails: string[];
}> {
  const passes: TurnReport["passes"] = [];
  const fails: TurnReport["fails"] = [];
  const negativeFails: TurnReport["negativeFails"] = [];

  for (const idea of expected.ideas) {
    if (keywordMatch(reply, idea)) {
      passes.push({ label: idea.label, method: "keyword" });
      continue;
    }
    // fallback LLM judge
    const j = await judgeIdea(reply, idea);
    if (j.match) {
      passes.push({ label: idea.label, method: "judge", reason: j.reason });
    } else {
      fails.push({ label: idea.label, reason: j.reason });
    }
  }

  if (expected.notIdeas) {
    for (const idea of expected.notIdeas) {
      const norm = normalize(reply);
      const hit = idea.anyOf.find((kw) => norm.includes(normalize(kw)));
      if (hit) {
        negativeFails.push({ label: idea.label, matched: hit });
      }
    }
  }

  const styleFails = deterministicStyleCheck(reply);

  return { passes, fails, negativeFails, styleFails };
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function run() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const filter = process.env.SCENARIOS?.trim();
  const selected = filter
    ? SCENARIOS.filter((s) => filter.split(",").some((f) => s.name.includes(f.trim())))
    : SCENARIOS;

  console.log(`\n🏃 Run: ${runId}  |  Scenarios: ${selected.length}${filter ? ` (filter="${filter}")` : ""}`);

  let totalIdeas = 0;
  let totalPasses = 0;
  let totalFails = 0;
  let totalNegFails = 0;
  let totalStyleFails = 0;
  const failedTurns: { scenario: string; turn: number; customer: string; reply: string; fails: TurnReport["fails"]; negs: TurnReport["negativeFails"]; styleFails: string[] }[] = [];

  for (const sc of selected) {
    const threadId = `test-kichban-${runId}-${sc.name}`;
    const resourceId = "kichban-tester";

    console.log(`\n${"═".repeat(78)}\n▶  ${sc.name}\n${"═".repeat(78)}`);

    for (let i = 0; i < sc.turns.length; i++) {
      const expected = sc.turns[i];
      let reply = "";
      try {
        const run = await routerWorkflow.createRun();
        const result = await run.start({
          inputData: { message: expected.customer, threadId, resourceId },
        });
        const steps = (result as any).steps ?? {};
        const out =
          steps["call-fitness"]?.output ??
          steps["call-giai-co"]?.output ??
          steps["fallback"]?.output ??
          null;
        reply = (out?.reply ?? "").trim();
      } catch (e) {
        console.error(`  [T${i + 1}] error:`, e);
      }

      const state = await loadState(mastra, threadId, resourceId);
      const { passes, fails, negativeFails, styleFails } = await checkTurn(reply, expected);
      totalIdeas += expected.ideas.length;
      totalPasses += passes.length;
      totalFails += fails.length;
      totalNegFails += negativeFails.length;
      totalStyleFails += styleFails.length;

      console.log(`\n[T${i + 1}] KH: ${expected.customer}`);
      console.log(`     stage=${state.stage} intent=${state.intent}`);
      console.log(`     BOT: ${reply.replace(/\n/g, "\n          ")}`);
      for (const p of passes) {
        console.log(`     ✓ ${p.label} [${p.method}]${p.reason ? ` — ${p.reason}` : ""}`);
      }
      for (const f of fails) {
        console.log(`     ✗ ${f.label} — ${f.reason}`);
      }
      for (const n of negativeFails) {
        console.log(`     ⚠ NEG ${n.label} (matched: "${n.matched}")`);
      }
      for (const s of styleFails) {
        console.log(`     ✗ STYLE: ${s}`);
      }

      if (fails.length > 0 || negativeFails.length > 0 || styleFails.length > 0) {
        failedTurns.push({
          scenario: sc.name,
          turn: i + 1,
          customer: expected.customer,
          reply,
          fails,
          negs: negativeFails,
          styleFails,
        });
      }
    }
  }

  console.log(`\n${"═".repeat(78)}\nSUMMARY\n${"═".repeat(78)}`);
  console.log(`Ideas: ${totalPasses}/${totalIdeas} pass — ${totalFails} fail`);
  if (totalNegFails > 0) console.log(`Negative violations: ${totalNegFails}`);
  if (totalStyleFails > 0) console.log(`Style violations: ${totalStyleFails}`);
  console.log(`Failed turns: ${failedTurns.length}`);

  if (failedTurns.length > 0) {
    console.log(`\nDETAIL FAILED:`);
    for (const ft of failedTurns) {
      console.log(`  - ${ft.scenario} T${ft.turn}: "${ft.customer}"`);
      console.log(`      BOT: ${ft.reply.slice(0, 200)}`);
      for (const f of ft.fails) console.log(`      ✗ ${f.label} — ${f.reason}`);
      for (const n of ft.negs) console.log(`      ⚠ NEG ${n.label}`);
      for (const s of ft.styleFails) console.log(`      ✗ STYLE: ${s}`);
    }
    process.exit(1);
  }

  console.log(`\n✅ ALL PASS`);
  process.exit(0);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
