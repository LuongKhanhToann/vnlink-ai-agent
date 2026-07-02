/**
 * stateMachine.ts
 *
 * KIẾN TRÚC: FSM kiểm soát flow, LLM chỉ lo ngôn ngữ.
 *
 * Code quyết định:
 *   - Stage transition (dựa trên slots đã fill)
 *   - Temperature (dựa trên slot density + intent)
 *   - Slot trust (store-first, LLM chỉ extract những slot NULL)
 *
 * LLM quyết định:
 *   - Ngôn ngữ / tone của response
 *   - Emotion classification
 *   - Flow detection (fitness vs giai-co) — với keyword pre-check
 *   - Extract slots còn thiếu từ message mới
 */

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export type Flow = "fitness" | "giai-co";

export type Stage =
  | "opening"
  | "discovery"
  | "inbody"       // pitch Inbody miễn phí — mandatory funnel trước evaluation
  | "evaluation"
  | "negotiation"
  | "commitment"
  | "objection"
  | "recovery"
  | "retention";

export type Temperature = "cold" | "warm" | "hot";

export type Emotion =
  | "neutral"
  | "excited"
  | "anxious"
  | "frustrated"
  | "hesitant"
  | "trusting";

export type Intent = "explore" | "compare" | "selecting" | "ready";

// ─────────────────────────────────────────────
// INTENT TOPIC — phân loại nội dung KH đang hỏi/nói (semantic intent)
// Khác Intent (explore/compare/selecting/ready) ở scope: Intent là MỨC độ commit;
// IntentTopic là CHỦ ĐỀ tin nhắn. Cả 2 cùng do LLM classifier output.
//
// Topic chính được map sang template trong questionFlow.ts. null = bot fallback
// về reply tự nhiên qua agent prompt (TACTIC/EXAMPLE).
// ─────────────────────────────────────────────

export type IntentTopic =
  // Opening — turn 1 chưa rõ nhu cầu
  | "opening_greeting"            // "Quan tâm", "Hi", chào suông
  | "opening_chuong_trinh"        // "Tư vấn chương trình tập luyện", "có chương trình gì"
  | "opening_chua_biet"           // "chưa biết tập gì", "cho chị tham khảo"
  | "indecisive_pick_for_me"      // "chị chọn giúp em", "tư vấn giúp em" (KH nhờ tư vấn, có thể đã có goal/serviceType)
  | "tham_quan"                   // "đi qua tham quan thôi"
  // Intro mục tiêu/môn (có thể fire bất kể turn)
  | "intro_trai_nghiem"           // "muốn tập trải nghiệm", "muốn thử"
  | "intro_giam_can"              // "muốn giảm cân", "giảm mỡ", "giảm béo"
  | "intro_uu_dai"                // "có ưu đãi/khuyến mãi gì không"
  // Trial-related
  | "trial_ask_confirm"           // "có được tập thử không"
  | "trial_register_how"          // "đăng ký trải nghiệm như thế nào"
  // Discovery answers / class structure
  | "no_experience"               // "chưa tập bao giờ", "chưa từng"
  | "has_experience"              // "đã tập rồi", "tập rồi", "có tập", "từng đi rồi"
  | "new_class_inquiry"           // "có lớp cho người mới không em"
  | "class_has_newbies"           // "Lớp bây giờ có người mới không"
  // Logistics — giờ mở cửa / lúc nào qua được (KHÔNG dành riêng cho bể)
  | "ask_open_hours"              // "khi nào qua được", "mấy giờ mở cửa", "qua lúc nào"
  // Bơi
  | "pool_audience_ask"           // "muốn học bơi" — chưa rõ NL/TE
  | "pool_child_no_age"           // bơi cho con/bé — chưa nói tuổi
  | "pool_child_with_age"         // bơi cho con/bé — đã nói tuổi
  | "pool_hours"
  | "pool_temperature"
  | "pool_swimwear"
  | "pool_chlorine"
  | "pool_water_change"
  | "pool_lifeguard"
  | "pool_traffic"
  | "pool_limit"
  // Zumba
  | "zumba_vs_aerobic"            // so sánh Zumba vs Aerobic
  | "zumba_weight_loss"           // "Zumba có giảm cân không"
  // Pricing
  | "price_ask_generic"           // "bao nhiêu tiền/tháng", "giá thế nào"
  | "price_with_worry"            // giá + lo "không theo được"
  | "price_explicit_list"         // "có những gói nào", "gói giá nào em"
  | "price_objection"             // "đắt quá", "cao thế"
  // Goal/package
  | "full_package_confirm"        // "đăng ký gói Full" / "thẻ Full nhỉ"
  | "maintain_after_goal"         // "sau khi giảm cân muốn duy trì", "mất ngủ"
  | "guidance_ask"                // "có ai hướng dẫn không"
  | "combo_service_ask"           // "tập kèm dịch vụ khác không"
  // Media
  | "media_request"               // "cho xem ảnh phòng", "có hình không"
  // Switch service (giữa cuộc thoại) — slot extraction sẽ extract serviceType mới
  | "switch_service"              // "tôi quan tâm tập gym" (khi đang trên service khác)
  // ── EDGE TOPICS — câu hỏi ngoài kịch bản Fami chính thức ──
  | "ask_address"                 // "địa chỉ ở đâu", "trung tâm chỗ nào"
  | "ask_branch"                  // "có cơ sở 2 không", "chi nhánh ở HN"
  | "ask_facility"                // gửi xe, tủ đồ, phòng tắm, điều hòa, wifi, lọc khí
  | "ask_hold_policy"             // "thẻ có bảo lưu được không"
  | "ask_refund_policy"           // "không tập có hoàn tiền không"
  | "ask_change_package"          // "đổi gói giữa chừng được không"
  | "ask_unsupported_service"     // hỏi boxing/dance/aerobic standalone/kickbox/crossfit
  | "complaint_crowded"           // "phòng tập đông quá"
  | "ask_kid_supervision"         // "có chỗ trông trẻ con không"
  | "ask_postpartum_safety"       // "mới sinh / cho con bú tập được không"
  | "ask_prenatal_safety"         // "đang bầu X tháng tập được không"
  | "ask_senior_safety"           // "60+ tuổi / có bệnh nền tập được không"
  | "ask_rapid_weight_loss"       // "giảm 10kg trong 1 tháng" — mục tiêu phi thực tế
  | "ask_post_surgery"            // "vừa phẫu thuật / chấn thương phục hồi"
  | "ask_renewal"                 // "hội viên cũ gia hạn"
  | "ask_combo_pricing"           // "1 tháng combo bao nhiêu", "gym+yoga giá combo"
  | "ask_nutrition"               // "tư vấn ăn uống / chế độ ăn / whey protein"
  | "ask_corporate"               // "công ty / 20 nhân viên / gói doanh nghiệp"
  | "ask_pt_pricing"              // "PT 1-1 bao nhiêu / HLV riêng tháng nào"
  | "ask_hlv_gender"              // "có HLV nữ/nam không"
  | "ask_payment_method"          // "trả góp / thẻ credit / chuyển khoản"
  | "ask_student_pricing"         // "X tuổi tập được không / có gói học sinh"
  | "ask_teen_safety";            // "em 15/16/17 tuổi tập gym tăng cơ được không"

// ─────────────────────────────────────────────
// KNOWN INFO — khác nhau giữa 2 flows
// ─────────────────────────────────────────────

export interface KnownInfo {
  // Chung
  name: string | null;
  phone: string | null;

  // Fitness
  serviceType: string | null;     // gym / yoga / zumba / boi / pilates / full
  memberType: string | null;      // ca-nhan / gia-dinh / hoc-sinh
  durationMonths: number | null;  // 1 / 3 / 6 / 12 / 24 / 36
  schedule: string | null;        // khung giờ / buổi mong muốn
  fitnessGoal: string | null;     // mục tiêu: giam-mo / tang-co / tang-can / thu-gian / hoc-boi / suc-khoe / giu-dang
  bodyStats: string | null;       // chỉ số cơ thể KH tự khai (cao/nặng/số kg muốn đổi) — classifier (LLM) trích, KHÔNG regex
  gender: string | null;          // "nam" / "nu" — classifier (LLM) suy từ cách khách tự xưng/ngữ cảnh; để chọn cột bảng cân chuẩn

  // Giải cơ
  painArea: string | null;        // vùng đau: vai-gay / lung / chan / toan-than / ...
  painSpread: string | null;      // lan tỏa hay điểm cố định: "lan-toa" / "diem-co-dinh" / mô tả cụ thể
  painDuration: string | null;    // đau bao lâu + khi nào nhắc nhở (VD: "vài hôm sáng dậy", "1 tuần ngồi lâu")
  pastMethod: string | null;      // đã thử phương pháp nào: chua-thu / massage / thuoc / vat-ly-tri-lieu / khac
  sessionPackage: string | null;  // le / 5-buoi / 10-buoi / 20-buoi
  preferredTime: string | null;   // giờ muốn đặt lịch (cụm giờ/buổi NGUYÊN VĂN — vd "2h chiều", "10h sáng mai 18/06")
  // Ngày hẹn TUYỆT ĐỐI đã RESOLVE "DD/MM/YYYY" (classifier LLM resolve từ bảng NGÀY HIỆN TẠI).
  // Là DANH TÍNH buổi hẹn (khóa chống trùng đơn = người + NGÀY), KHÁC preferredTime (chỉ là cụm hiển thị).
  // null khi KH chưa nêu ngày cụ thể (chỉ giờ/buổi trơ, hoặc cửa sổ nhiều ngày "cuối tuần").
  // CARRY-FORWARD: tin mới chỉ đổi giờ ("2h chiều") → giữ NGUYÊN ngày cũ (xem pickWithReextract ở mergeSlots).
  appointmentDate: string | null;
}

/** Nước đi media CHỦ ĐỘNG do classifier (LLM) quyết định mỗi turn — như sale khôn khéo, gửi đúng lúc.
 *  - none         = không gửi gì turn này.
 *  - show_service = bung ảnh/video bộ môn/không gian khách đang quan tâm (gym/yoga/zumba/pool/giải-cơ).
 *  - show_results = bung ảnh kết quả (hội viên trước-sau / ca trị liệu trước-sau) để chốt niềm tin.
 *  QUYẾT ĐỊNH ở classifier; THỰC THI deterministic ở routerWorkflow (fetchMedia thẳng, chống flaky tool-call). */
export type MediaMove = "none" | "show_service" | "show_results";

export interface ConversationState {
  flow: Flow;
  stage: Stage;
  temperature: Temperature;
  emotion: Emotion;
  intent: Intent;
  // intentTopic: chủ đề ngữ nghĩa của tin nhắn turn hiện tại (LLM classify mỗi turn).
  // Transient — chỉ dùng cho turn này, không persist semantics. State có lưu để các
  // hàm downstream (questionFlow, prefixBuilder GATE) đọc thay vì regex parse lại message.
  intentTopic: IntentTopic | null;
  /** Intent classify 3-trục (domain/service/attribute) — Phase 1 refactor. intentTopic ở trên được derive từ đây
   *  qua signalToLegacyTopic() trong classifier. Phase 2 sẽ port templates dùng intentSignal trực tiếp. */
  intentSignal?: import("./intent").IntentSignal | null;
  /** Multi-intent: nếu KH hỏi 2-3 thứ trong 1 tin, primary nằm ở intentSignal, còn lại ở đây (max 2).
   *  prefixBuilder render hint MULTI-INTENT để agent trả lời CẢ secondary trong cùng reply. */
  secondaryIntents?: import("./intent").IntentSignal[];
  /** Nước đi media chủ động classifier quyết turn này (xem [[MediaMove]]). Transient — chỉ cho turn hiện tại. */
  mediaMove?: MediaMove;
  honorific: "anh" | "chị" | "anh/chị";
  knownInfo: KnownInfo;
  /** Tổng số turn của cuộc thoại — KHÔNG reset khi flow đổi. Dùng cho greeting decision. */
  turnCount: number;
  /** Số turn trong flow HIỆN TẠI — reset về 1 khi flow đổi. Dùng cho anti-loop guards. */
  flowTurnCount: number;
  qrShown: boolean;
  mediaShown: boolean;
  // Track riêng từng key media đã gửi — cho phép gửi media khi khách hỏi DỊCH VỤ MỚI.
  // Vd: đã gửi fitness-pool, khách hỏi zumba → gửi fitness-zumba (key chưa có trong list).
  mediaShownKeys: string[];
  /** ≥1 đơn đã ghi Sheets thành công. KHÔNG còn khóa chat — chỉ dùng để chuyển sang
   *  chế độ retention (concierge sau chốt). Xem [[bookingsWritten]] cho dedup ghi đơn. */
  sheetsWritten: boolean;
  /** Chữ ký các đơn ĐÃ ghi Sheets — dedup cho multi-order. Mỗi entry = `flow|tên|SĐT|NGÀY`
   *  (xem bookingSignature(); NGÀY = lõi "DD/MM" của appointmentDate, fallback giờ khi chưa có ngày).
   *  Đặt buổi NGÀY khác / người khác → chữ ký mới → ghi dòng tiếp; đổi GIỜ cùng ngày → UPDATE dòng cũ.
   *  Thay cho cơ chế khóa boolean cũ (chỉ ghi 1 lần rồi im lặng). */
  bookingsWritten?: string[];
  /** Multi-service far-context: TẤT CẢ bộ môn KH đã quan tâm xuyên các turn (gym/yoga/zumba/boi/pilates).
   *  Khác serviceType (= focus hiện tại). Dùng để bot nhớ & tư vấn song song từng môn,
   *  KHÔNG tự gộp về thẻ Full trừ khi KH hỏi combo. */
  servicesInterested?: string[];
  /** Transient (per-turn): khi KH ĐỔI LỊCH 1 đơn ĐÃ ghi → giữ giờ CŨ để tryWriteLeadIfReady
   *  UPDATE đúng dòng Sheets thay vì append dòng mới. buildNextState set lại mỗi turn (null nếu không đổi). */
  rescheduleFromTime?: string | null;
  lastBotReply?: string;
  /** Tin nhắn user của turn TRƯỚC. Dùng cho guard cross-turn (vd "bé 10 tuổi" ở turn 2 → tránh
   *  hỏi lại tuổi ở turn 3). KHÁC `message` đang xử lý (current turn). */
  lastUserMessage?: string;
  /** Phase 6: keys của câu hỏi bot đã hỏi (vd "exp_gym", "goal", "schedule").
   *  Anti-loop: bot không hỏi lại câu cùng key. Xem lib/tracking.ts cho QUESTION_KEY_PATTERNS. */
  askedHistory?: string[];
  /** Phase 6: keys của fact bot đã pitch (vd "inbody_free", "full_7tr", "be_4_mua").
   *  Anti-repeat-pitch: bot không repeat same value. Xem lib/tracking.ts cho FACT_KEY_PATTERNS. */
  mentionedFacts?: string[];
  /** Các chủ đề trấn an SAFETY đã trả lời (postpartum/prenatal/senior/post_surgery/teen).
   *  Sticky toàn cuộc thoại (KHÔNG chỉ turn trước). Template safety đọc field này để KHÔNG bắn lại
   *  NGUYÊN VĂN đoạn trấn an dài ở lượt sau (lỗi HARD-LOOP lộ máy) — nhường LLM trả lời ngắn, sát. */
  safetyTopicsCovered?: string[];
  /** Sticky toàn cuộc thoại: KH đang trong cửa sổ chấn thương CẤP TÍNH (vừa bị, sưng nóng <72h).
   *  Set khi classifier attribute=acute_injury. Giữ NGUYÊN các turn sau (KH hỏi "khi nào qua được",
   *  cảm ơn, chitchat) để bot KHÔNG rơi lại funnel discovery/pitch — chỉ trấn an + hẹn quay lại sau
   *  3-5 ngày khi hết sưng nóng. Xem [GATE chấn thương cấp] ở prefixBuilder. */
  acuteInjuryHold?: boolean;
  /** Sticky toàn cuộc thoại: KH là DOANH NGHIỆP/công ty mua gói cho nhân viên/đoàn.
   *  Set khi classifier attribute=corporate / intentTopic=ask_corporate. Giữ NGUYÊN các turn sau
   *  (KH hỏi "bao nhiêu 1 người" → classifier ra pricing, mất context corporate) → bot KHÔNG báo
   *  giá lẻ retail mà giữ hướng "ưu đãi riêng cho công ty, để sale báo". Xem GATE doanh nghiệp. */
  corporateHold?: boolean;
  /** ID template bot gửi ở lượt TRƯỚC (vd "ask_pain_after_goal_giam-mo"). Tín hiệu TẤT ĐỊNH
   *  (id mình kiểm soát, KHÔNG regex) cho anti-loop: vd biết "đã hỏi nỗi đau rồi" để không hỏi lại. */
  lastTemplateId?: string | null;
  /** 3 reply gần nhất của bot — cho anti-parrot: model nhỏ đôi khi nhại lại NGUYÊN VĂN câu cũ
   *  cách 1-2 lượt (HARD-LOOP không liền kề). cleanReply so similarity với cả list này. */
  recentBotReplies?: string[];
}

// ─────────────────────────────────────────────
// SLOT MERGE — Store-first
// ─────────────────────────────────────────────

export function mergeSlots(
  existing: KnownInfo,
  extracted: Partial<KnownInfo>
): KnownInfo {
  // Store-first: existing value luôn được giữ nguyên nếu đã có.
  // extracted chỉ được dùng khi existing === null VÀ extracted có giá trị thật (không null/undefined).
  function pick<T>(e: T | null, x: T | null | undefined): T | null {
    if (e !== null) return e;
    if (x !== null && x !== undefined) return x;
    return null;
  }

  // Ngoại lệ: preferredTime có thể refine HOẶC đổi ý.
  //   Refine:   existing="sáng"            extracted="sáng thứ 7 26/04"  → lấy extracted
  //   Đổi ý:    existing="thứ 7 26/04 9h"  extracted="sáng mai"          → lấy extracted
  //                                                                       (khách chủ động đổi)
  // Logic:
  //   1) extracted null/undefined → giữ existing (classifier không thấy tín hiệu thời gian).
  //   2) extracted bằng existing → no-op.
  //   3) extracted có tín hiệu thời gian rõ ràng → trust extracted (refine hoặc đổi ý).
  //   4) còn lại → giữ existing để tránh classifier nhiễu xóa mất giá trị tốt.
  function pickPreferredTime(
    e: string | null,
    x: string | null | undefined
  ): string | null {
    if (x === null || x === undefined) return e;
    if (e === null) return x;
    if (x === e) return e;
    const hasTimeSignal =
      /(sáng|chiều|tối|trưa|thứ|chủ\s?nhật|\bcn\b|\d{1,2}h|\d{1,2}\/\d{1,2}|mai|hôm nay|hôm qua|đầu tuần|giữa tuần|cuối tuần|tuần sau|tuần tới|đầu tháng|giữa tháng|cuối tháng|tháng sau|vài hôm|mấy hôm|ngày kia)/i.test(
        x,
      );
    return hasTimeSignal ? x : e;
  }

  // Slot có thể bị classifier suy diễn sai ngay turn đầu (vd pastMethod="chua-thu"
  // khi khách chưa nói gì). Khi re-extract trả về value mới non-null → trust mới.
  // Classifier chỉ được yêu cầu extract slot này khi có cue rõ ràng → an toàn để override.
  function pickWithReextract<T>(e: T | null, x: T | null | undefined): T | null {
    if (x === null || x === undefined) return e;
    return x;
  }

  // Fami chỉ có 5 service: gym/yoga/zumba/boi/pilates (+ full combo).
  // Reject mọi giá trị khác (vd "aerobic" — khách nhắc để so sánh nhưng KHÔNG phải dịch vụ
  // bên em → không được switch sang).
  //
  // serviceType = FOCUS hiện tại (1 môn KH đang bàn). KHÔNG gộp multi về "full" nữa
  // (yêu cầu: tư vấn song song từng môn, để KH tự quyết lẻ hay combo).
  // Khi classifier trả "gym và bơi" → lấy môn PRIMARY (đầu tiên) làm focus;
  // các môn còn lại được tích lũy vào servicesInterested (xem collectServices + buildNextState).
  // "full"/"combo" CHỈ set khi KH chủ động nói (vd "thẻ full", "gói combo 4") — đã nằm trong valid list.
  function pickServiceType(
    e: string | null,
    x: string | null | undefined,
  ): string | null {
    // KH gọi thẳng tên gói FULL/combo (classifier extract serviceType="full") → ĐỔI focus
    // sang "full" dù trước đó đang bàn 1 môn lẻ (vd zumba). Full là superset cả 4 dịch vụ nên
    // override an toàn; nếu không thì PRICING kẹt ở môn lẻ, báo sai gói khi KH hỏi "gói full"
    // (bug L2 T12). Các switch lẻ khác (gym↔yoga…) vẫn giữ sticky như cũ.
    if (typeof x === "string" && x.toLowerCase() === "full") return "full";
    if (e !== null) return e;
    if (x === null || x === undefined) return null;
    const valid = ["gym", "yoga", "zumba", "boi", "pilates", "full"];
    const lower = x.toLowerCase();
    if (valid.includes(lower)) return lower;
    // Comparison cue trong classifier output ("gym với yoga", "gym hay yoga", "X vs Y", "X so với Y", "cái nào")
    // → KHÔNG treat as multi-service. Để null cho classifier prompt xử lý đúng.
    const isCompareCue = /(với|hay|vs\.?|so\s*với|cái\s*nào)/i.test(lower);
    if (isCompareCue) return null;
    // Multi-service: "gym và bơi", "yoga + zumba" → lấy môn ĐẦU TIÊN làm focus (KHÔNG gộp Full).
    const services = lower.match(/(gym|yoga|zumba|bơi|boi|pilates)/g) || [];
    const first = services[0];
    if (first) {
      return first === "bơi" ? "boi" : first;
    }
    return null;
  }

  return {
    name:           pick(existing.name,           extracted.name),
    phone:          pick(existing.phone,          extracted.phone),
    serviceType:    pickServiceType(existing.serviceType, extracted.serviceType),
    memberType:     pick(existing.memberType,     extracted.memberType),
    durationMonths: pick(existing.durationMonths, extracted.durationMonths),
    schedule:       pick(existing.schedule,       extracted.schedule),
    // fitnessGoal: KH có thể bổ sung / đổi mục tiêu giữa cuộc thoại (vd "muốn học bơi" rồi "và muốn giảm cân").
    // Classifier chỉ extract khi có cue rõ ràng nên an toàn để override với value mới.
    fitnessGoal:    pickWithReextract(existing.fitnessGoal, extracted.fitnessGoal),
    // bodyStats: store-first nhưng cho REFINE — khách bổ sung dần (turn 1 "85kg", turn 2 "muốn giảm 8kg").
    bodyStats:      pickWithReextract(existing.bodyStats,  extracted.bodyStats),
    // gender: store-first thuần — giới tính không đổi giữa cuộc thoại, chỉ điền khi đang trống.
    gender:         existing.gender ?? extracted.gender ?? null,
    painArea:       pickWithReextract(existing.painArea,   extracted.painArea),
    painSpread:     pickWithReextract(existing.painSpread, extracted.painSpread),
    painDuration:   pick(existing.painDuration,   extracted.painDuration),
    pastMethod:     pickWithReextract(existing.pastMethod, extracted.pastMethod),
    sessionPackage: pick(existing.sessionPackage, extracted.sessionPackage),
    preferredTime:  pickPreferredTime(existing.preferredTime, extracted.preferredTime),
    // appointmentDate carry-forward: ngày mới non-null → override (KH đổi sang ngày khác);
    // null → GIỮ ngày cũ (tin chỉ đổi giờ "2h chiều" KHÔNG được làm rớt ngày 18/06 đã chốt).
    appointmentDate: pickWithReextract(existing.appointmentDate, extracted.appointmentDate),
  };
}

/**
 * Chấm độ cụ thể của preferredTime để quyết định có override hay không.
 *   +2 = có ngày DD/MM
 *   +2 = có giờ cụ thể (VD "9h", "15h30")
 *   +1 = có buổi (sáng/chiều/tối)
 *   +1 = có thứ trong tuần (thứ 2..7, chủ nhật, CN)
 * Value càng cụ thể → điểm càng cao.
 */
export function preferredTimeScore(s: string | null): number {
  if (s === null) return -1;
  let score = 0;
  if (/\d{1,2}\/\d{1,2}/.test(s)) score += 2;
  if (/\d{1,2}h/i.test(s)) score += 2;
  if (/(sáng|chiều|tối|trưa)/i.test(s)) score += 1;
  if (/(thứ\s?[2-7]|chủ\s?nhật|\bcn\b)/i.test(s)) score += 1;
  return score;
}

/**
 * Kiểm tra preferredTime đã đủ cụ thể chưa (có ngày hoặc thứ).
 * Dùng để quyết định có nên re-extract không.
 */
export function isPreferredTimeSpecific(s: string | null): boolean {
  if (s === null) return false;
  return /\d{1,2}\/\d{1,2}/.test(s) || /(thứ\s?[2-7]|chủ\s?nhật|\bcn\b)/i.test(s);
}

export function nullSlots(info: KnownInfo): (keyof KnownInfo)[] {
  return (Object.keys(info) as (keyof KnownInfo)[]).filter(
    (k) => info[k] === null
  );
}

// ─────────────────────────────────────────────
// FLOW DETECTION — Keyword pre-check
//
// QUYẾT ĐỊNH FLOW theo thứ tự ưu tiên:
//   1. PAIN_PRIORITY (đang đau/nhức/mỏi/cứng + body part) → giai-co
//      kể cả khi tin có "gym/yoga" (vd "tập gym xong đau lưng" → giai-co
//      để xử đau trước, sau đó mới quay lại fitness).
//   2. GIAI_CO_KEYWORDS (massage/giải cơ/spa/...) → giai-co
//   3. FITNESS_KEYWORDS (gym/yoga/swim/tăng cơ/giảm mỡ/...) → fitness
//   4. Cả 2 cùng có / không có gì → null → để LLM classifier quyết
//
// ⚠️ Vietnamese không dùng được `\b` (ả/ơ/đ không phải word char trong regex
// mặc định). Dùng `u` flag + lookaround `(?<!\p{L})` / `(?!\p{L})` cho boundary.
// ─────────────────────────────────────────────

const VI_BOUND_L = "(?<!\\p{L})";
const VI_BOUND_R = "(?!\\p{L})";

const FITNESS_KEYWORDS = new RegExp(
  `${VI_BOUND_L}(?:gym|yoga|zumba|bơi|pilates|thể dục|tập luyện|thể hình|thẻ tập|hội viên|fitness|aerobic|inbody|hlv|huấn luyện viên|pool|bể bơi|thể thao|tăng cơ|giảm mỡ|giảm cân|đốt mỡ|săn chắc|vóc dáng|thân hình)${VI_BOUND_R}`,
  "iu",
);

// Bỏ "spa" và "xông hơi" khỏi giai-co keywords vì gym/fitness center cũng thường
// có khu sauna/xông hơi như amenity. Khách hỏi "có sauna không" KHÔNG phải hỏi
// dịch vụ giải cơ — sẽ được routing đến ask_facility (fitness flow).
const GIAI_CO_KEYWORDS = new RegExp(
  `${VI_BOUND_L}(?:giải cơ|massage|xoa bóp|đau lưng|đau vai|đau cổ|đau gáy|vật lý trị liệu|trigger|fascia|cứng cơ|đau mỏi|nhức mỏi|ngâm bồn|regenix|hoa sen)${VI_BOUND_R}`,
  "iu",
);

// PAIN_PRIORITY: đang đau/nhức/mỏi/cứng + body part. Cho phép filler ngắn
// (tôi/anh/chị/ở/vùng/phần/đang/hơi…) giữa body part và pain word ở cả 2 chiều.
const BODY_PART = "(?:lưng|vai|cổ|gáy|chân|gối|hông|mông|tay|đầu\\s*gối)";
const PAIN_WORD = "(?:đau|nhức|mỏi|cứng)";
const PAIN_PRIORITY = new RegExp(
  `${PAIN_WORD}\\s+(?:[\\p{L}\\s]{0,15}?)?${BODY_PART}` +              // "đau (ở/phần) cổ"
    `|${BODY_PART}\\s+(?:[\\p{L}\\s]{0,15}?)?${PAIN_WORD}` +           // "lưng (tôi đang) đau"
    `|nhức\\s+(?:mỏi|cơ)|cứng\\s+cơ|mỏi\\s+(?:lưng|vai|cổ|gáy|chân|gối|hông|cơ)`,
  "iu",
);

// Detect "tên + sđt cùng dòng" deterministic — backup khi LLM classifier extract sót name.
// Vd: "toàn 0373389191" / "an 0912345678" — tên 1 từ (có thể trùng từ vựng) + sđt 9-11 số.
// LLM classifier (gpt-4o-mini) hay miss khi tên lowercase/ambiguous → cần regex fallback.
//
// Pattern hỗ trợ:
//   "<tên> <sđt>"        → "toàn 0373389191" / "Lan 0912345678"
//   "<tên>, <sđt>"       → "Toàn, 0912345678"
//   "<tên> sđt <sđt>"    → "An sđt 0912345678"
//   "tên <tên> sđt <sđt>" → "tên Toàn sđt 0912345678"
//
// Vietnamese name chars: 1-3 từ, mỗi từ ≤ 12 chars, chỉ chứa Unicode letter (\p{L}).
// Phone: 9-11 chữ số liên tiếp (có thể có dấu cách/gạch nhưng strip trước).
/**
 * Strip động từ/xưng hô dẫn vào tên do extract slot `name` nuốt phải.
 * Vd: "Là Trung" → "Trung", "tên anh là Lan" → "Lan", "mình tên Hùng" → "Hùng".
 * Bảo thủ: chỉ cắt các tiền tố cố định (tên/họ/xưng hô + copula "là"), KHÔNG đụng phần tên thật
 * ("Anh Tuấn", "Lan Anh" giữ nguyên). Dùng cho CẢ LLM path (classifier) lẫn inline/standalone extractor.
 */
export function sanitizeName(raw: string): string | null {
  let n = (raw ?? "").trim();
  if (!n) return null;
  let prev: string;
  do {
    prev = n;
    n = n
      .replace(/^(họ\s+tên|tên\s+gọi|tên)\s+/iu, "")        // "tên ...", "họ tên ..."
      .replace(/^của\s+/iu, "")                              // "của em ..."
      .replace(/^(anh|chị|em|mình|tôi|con|cô|chú|bác|cháu)\s+(là|tên)\s+/iu, "") // "anh là", "mình tên"
      .replace(/^là\s+/iu, "")                               // copula "là" đứng đầu → "Là Trung"
      .trim();
  } while (n !== prev && n.length > 0);
  return n.length ? n : null;
}

/**
 * Lưới chống classifier BỊA thứ/ngày khi khách chỉ cho KHOẢNG GIỜ ("tối 7-9h").
 * Bug thật (real_tang_co_bao_gia_ngay T3): "tối 7-9h" (19-21h) → classifier resolve
 * "19h tối thứ 7 13/06" (đọc "7-9h" thành "thứ 7" + bịa ngày 13/06 khách KHÔNG nói).
 * Bot tự bịa ngày đặt lịch = lỗi CORRECTNESS (chốt nhầm ngày). Khi MESSAGE có range-giờ ("\d-\dh")
 * mà KHÔNG nêu thứ/ngày → mọi "thứ N"/"DD/MM" trong preferredTime là BỊA → cắt, giữ phần giờ/buổi.
 * Bảo thủ: chỉ cắt khi message THỰC SỰ vắng cue thứ/ngày (tránh nuốt lịch thật khách cho).
 */
export function sanitizePreferredTime(
  extracted: string | null | undefined,
  message: string,
): string | null {
  if (!extracted) return extracted ?? null;
  const msg = (message || "").toLowerCase();

  // Cue NGÀY/THỨ khách CÓ nêu trong message.
  const msgHasDayOrDate =
    /(thứ\s*[2-7]|thứ\s*(hai|ba|tư|năm|sáu|bảy)|chủ\s*nhật|(?<!\p{L})cn(?!\p{L})|cuối\s*tuần|đầu\s*tuần)/iu.test(msg) ||
    /(\d{1,2}\s*\/\s*\d{1,2}|ngày\s*\d|hôm\s*nay|ngày\s*mai|(?<!\p{L})mai(?!\p{L})|(?<!\p{L})mốt(?!\p{L})|(?<!\p{L})kia(?!\p{L})|tuần\s*(sau|tới)|(?<!\p{L})nay(?!\p{L}))/iu.test(msg);
  // Cue GIỜ ("8h", "17 giờ") / BUỔI ("sáng/trưa/chiều/tối/đêm" — KHÔNG tính "1 buổi" = 1 session).
  const msgHasClock = /\d{1,2}\s*(h|giờ)/i.test(msg);
  const msgHasDaypart = /(?<!\p{L})(sáng|trưa|chiều|tối|đêm)(?!\p{L})/iu.test(msg);

  // FABRICATION 100%: message KHÔNG có BẤT KỲ cue thời gian nào mà classifier vẫn trả preferredTime
  // (vd "ok qua thử" / "thử 1 buổi xem" → "17h chiều thứ 4 17/06") → BỊA hoàn toàn, cắt sạch.
  // An toàn: mergeSlots vẫn giữ preferredTime CŨ trong state → chỉ chặn giá trị mới bịa, KHÔNG xoá lịch thật.
  if (!msgHasDayOrDate && !msgHasClock && !msgHasDaypart) return null;

  // Range-giờ kiểu "7-9h", "7h-9h", "19-21h", "7 - 9h" (KHÔNG khớp "3-4 buổi": cần "h" sau số cuối).
  const hasHourRange = /\d{1,2}\s*h?\s*[-–—]\s*\d{1,2}\s*h/.test(msg);
  // Range-giờ mà KHÔNG nêu thứ/ngày → cắt "thứ N" + "DD/MM" BỊA trong extracted, giữ giờ/buổi.
  if (hasHourRange && !msgHasDayOrDate) {
    const cleaned = extracted
      .replace(/\s*(thứ\s*[2-7]|thứ\s*(hai|ba|tư|năm|sáu|bảy)|chủ\s*nhật|(?<!\p{L})cn(?!\p{L}))/giu, "")
      .replace(/\s*\d{1,2}\s*\/\s*\d{1,2}/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return cleaned.length >= 2 ? cleaned : extracted;
  }
  return extracted;
}

export function detectNamePhoneInline(
  message: string,
): { name: string | null; phone: string | null } {
  if (!message) return { name: null, phone: null };
  const m = message.trim();
  // Strip ký tự không cần (giữ space + chữ + số).
  // Phone candidate: gom 9-11 chữ số liền (bỏ space giữa chừng).
  const phoneNorm = m.replace(/[\s.\-()]/g, "");
  const phoneMatch = phoneNorm.match(/(\d{9,11})/);
  if (!phoneMatch) return { name: null, phone: null };
  const phone = phoneMatch[1];

  // Tìm phần trước số trong message gốc (giữ space để tách word).
  // Cần locate vị trí của số đầu tiên trong message gốc (sau khi normalize space).
  // Đơn giản: match `^([^\d]*?)(\d[\d\s.\-()]*\d)`
  const beforeMatch = m.match(/^([^\d]*?)(?:\b|^)(\d[\d\s.\-()]*\d)/);
  if (!beforeMatch) return { name: null, phone };
  let beforeText = beforeMatch[1].trim();
  // Strip prefixes: "tên", "sđt", "số", "name", "phone", "là", ":" , "-", "anh", "chị", "em"
  beforeText = beforeText
    .replace(/[,:\-–—]/g, " ")
    .replace(/\b(tên|name|sđt|sdt|số|phone|là|của|anh|chị|em|mình|tôi|ok|oki|okay|alo|hi|hello|cũ|mới|mình|cho)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!beforeText) return { name: null, phone };
  // Loại stopwords cuối nếu còn ("ơi", "ạ"...).
  beforeText = beforeText
    .replace(/\s+(ơi|ạ|nha|nhé|à|ừ)$/i, "")
    .trim();
  // Validate: chỉ Unicode letter + space, 1-4 từ, mỗi từ ≤ 12 chars, total ≤ 30 chars.
  if (beforeText.length > 30) return { name: null, phone };
  if (!/^[\p{L}\s]+$/u.test(beforeText)) return { name: null, phone };
  const words = beforeText.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return { name: null, phone };
  if (words.some((w) => w.length > 12)) return { name: null, phone };
  // Capitalize tên (đầu mỗi từ in hoa).
  const name = words
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  return { name, phone };
}

// Detect tên ĐỨNG MỘT MÌNH khi context cho phép (bot vừa hỏi tên, KH chỉ gửi 1 cụm ngắn).
// Vd: "Toàn mà" / "tên là Hùng" / "chị Lan đây" — không có sđt cùng dòng.
//
// CHỈ fire khi:
//   - Bot ở turn trước đã hỏi tên (lastBotReply có "tên" / "tên gì")
//   - Hoặc state đã có phone nhưng thiếu name (high-confidence context)
// Validate strict: 1-3 từ, mỗi từ 2-12 chars chỉ Unicode letter, không phải common words.
// Common words filter để né "chiều mai" / "ok thôi" — tránh false positive cao.
// ⚠️ CỐ Ý KHÔNG include time words (mai/nay/sáng/tối/chiều/trưa) vì các từ này
// đồng âm với tên người phổ biến: "Mai", "Sáng", "Lan", "Hà"... Context check
// (bot vừa hỏi tên) đủ để disambiguate.
const COMMON_NON_NAME_WORDS = new Set([
  "có","không","ko","khong","được","duoc","rồi","vâng","dạ","ok","oki","okay",
  "thôi","thế","vậy","ừ","uh","cảm","ơn","tốt","tệ","hay","sao","gì","nào",
  "kia","khác","đây","đó","này","đấy","ấy",
  "đi","đến","qua","lên","xuống","ra","vào","tới","về","lại",
  "ạ","ơi","nha","nhé","mà","à","nè","luôn","ghé","thử","tập","đăng",
  "gym","yoga","zumba","bơi","pilates","full","pt","hlv","inbody",
  "tiền","giá","gói","tháng","tuần","ngày","buổi","giờ","phút",
  "muốn","cần","thích","biết","xem","cho","giúp","hỏi","là",
  "anh","chị","em","mình","tôi","bạn","cô","chú","bác","cháu","con","ông","bà",
]);

// Honorific prefix có thể strip mà KHÔNG mất ý nghĩa (vd "chị Mai đây" → "Mai").
const HONORIFIC_PREFIX_RE =
  /^(?:anh|chị|em|cô|chú|bác|cháu|ông|bà|mình|tôi|tớ)\s+/i;

export function detectNameStandalone(message: string): string | null {
  if (!message) return null;
  let m = message.trim();
  if (!m) return null;
  // Strip explicit "tên là X" / "tên X" / "là X" / "name is X" prefix.
  m = m.replace(
    /^(?:anh\s+|chị\s+|em\s+|mình\s+|tôi\s+|name\s+is\s+)?(?:tên\s+(?:là\s+)?|là\s+)/i,
    "",
  );
  // Strip honorific prefix nếu còn ("chị Mai đây" → "Mai đây").
  // Lặp 1 lần (không strip 2 honorific liên tiếp — quá rare + dễ nhầm).
  m = m.replace(HONORIFIC_PREFIX_RE, "");
  // Strip suffix: "mà", "đây", "nè", "đó", "này", "à", "ạ", "nha", "nhé", "thôi", "ơi"
  m = m.replace(/\s+(mà|đây|nè|đó|này|à|ạ|nha|nhé|thôi|ơi|nhỉ|đấy|ấy)$/i, "");
  m = m.trim();
  if (!m) return null;
  // Validate: ≤30 chars total, 1-3 từ, chỉ Unicode letter + space.
  if (m.length > 30) return null;
  if (!/^[\p{L}\s]+$/u.test(m)) return null;
  const words = m.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return null;
  // Mỗi từ: 2-12 chars (loại tên 1 chữ cái "A" — ambiguous abbreviation).
  if (words.some((w) => w.length < 2 || w.length > 12)) return null;
  // Reject nếu MỌI từ đều là common (vd "ok thôi", "không gì").
  const allCommon = words.every((w) => COMMON_NON_NAME_WORDS.has(w.toLowerCase()));
  if (allCommon) return null;
  // Reject time-phrase: từ đầu là time-leader VÀ có ≥2 từ → "chiều mai" / "sáng nay" / "tối thứ".
  // Cho phép 1-từ "Mai" / "Sáng" — có thể là tên người, context check ở caller xử lý.
  const TIME_LEADERS = new Set([
    "sáng","chiều","tối","trưa","ngày","buổi","tuần","tháng","năm","giờ","phút","sớm","khuya","đêm",
  ]);
  if (words.length >= 2 && TIME_LEADERS.has(words[0].toLowerCase())) return null;
  // Capitalize đầu mỗi từ.
  return words
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// Detect serviceType từ keyword — backup khi LLM classifier miss extract.
// Vd: "à không, cho anh yoga thôi" — classifier có khi không extract được "yoga".
export function detectServiceByKeyword(message: string): string | null {
  if (!message) return null;
  const m = message.toLowerCase();
  // Order: dùng từ ít ambiguity nhất trước
  if (/\bpilates?\b/.test(m)) return "pilates";
  if (/\b(yoga)\b/.test(m)) return "yoga";
  if (/\b(zumba)\b/.test(m)) return "zumba";
  if (/\b(gym|tập\s*gym|đăng\s*kí?\s*gym)\b/.test(m)) return "gym";
  // "bơi" phải có context (học bơi, tập bơi) để tránh false positive
  if (/(học\s*bơi|tập\s*bơi|bộ\s*môn\s*bơi|gói\s*bơi|đi\s*bơi|biết\s*bơi)/.test(m)) return "boi";
  if (/(gói\s*full|thẻ\s*full|combo\s*4|đa\s*dịch\s*vụ)/.test(m)) return "full";
  return null;
}

/**
 * Lưới TẤT ĐỊNH vá gap classifier hay miss goal. Chỉ fire khi classifier trả goal=null (backup).
 * - "lấy lại dáng / lấy dáng / về dáng" (mẹ bỉm sau sinh) → giam-mo.
 *   Bug (real_so_sanh T3): KH "mới sinh, cần lấy lại dáng" → classifier KHÔNG set fitnessGoal → goal=null
 *   → bot hỏi history lùi thay vì recommend.
 * - "giữ dáng / duy trì dáng / giữ form / giữ cân" → giu-dang (duy trì vóc dáng, KHÁC "lấy lại dáng").
 * - "tăng cân / lên cân / mập lên / ăn mãi không béo" → tang-can (người gầy muốn lên cân).
 * ⚠️ THỨ TỰ: nhánh giam-mo ("lấy lại dáng") đứng TRƯỚC giu-dang ("giữ dáng") để không bị nuốt.
 */
export function detectGoalByKeyword(message: string): string | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (/(lấy\s*lại\s*(vóc\s*)?dáng|lấy\s*dáng|về\s*dáng|lại\s*(vóc\s*)?dáng|gọn\s*dáng|thon\s*dáng)/.test(m))
    return "giam-mo";
  if (/(giữ\s*(vóc\s*)?dáng|duy\s*trì\s*(vóc\s*)?dáng|giữ\s*form|giữ\s*cân)/.test(m))
    return "giu-dang";
  if (/(tăng\s*cân|lên\s*cân|mập\s*lên|ăn\s*(mãi|hoài)[^.]*?(không|ko)\s*(béo|mập|lên\s*cân))/.test(m))
    return "tang-can";
  return null;
}

// Quét TẤT CẢ bộ môn Fami được nhắc trong 1 tin (gym/yoga/zumba/boi/pilates).
// Dùng cho servicesInterested (far-context multi-service). KHÁC detectServiceByKeyword
// (chỉ trả 1 focus). "bơi" cần context để tránh false-positive ("bơi trong tiền" ...).
export function collectServices(message: string): string[] {
  if (!message) return [];
  const m = message.toLowerCase();
  const found = new Set<string>();
  if (/\bpilates?\b/.test(m)) found.add("pilates");
  if (/\byoga\b/.test(m)) found.add("yoga");
  if (/\bzumba\b/.test(m)) found.add("zumba");
  if (/(\bgym\b|tập\s*gym|đăng\s*kí?\s*gym|phòng\s*gym)/.test(m)) found.add("gym");
  // "bơi" trong tiếng Việt gần như luôn = bơi lội → bắt cả khi đứng trần (boundary VI-safe),
  // không cần ép context. (detectServiceByKeyword cho FOCUS vẫn giữ context để né false-focus.)
  if (/(?<!\p{L})bơi(?!\p{L})/u.test(m)) found.add("boi");
  return [...found];
}

// Lõi NGÀY "DD/MM" của appointmentDate ("DD/MM/YYYY") — dùng làm khóa danh tính + để match dòng Sheet.
// Pure slice (KHÔNG regex): classifier được ép trả đúng format "DD/MM/YYYY" nên 5 ký tự đầu = "DD/MM".
// Năm bỏ khỏi KHÓA (1 người đặt đúng 18/06 ở 2 năm khác nhau = phi thực tế) cho khóa gọn & ổn định.
export function appointmentDateKey(d: string | null): string | null {
  if (!d) return null;
  const core = d.trim().slice(0, 5);
  return core.length >= 4 ? core : d.trim();
}

// Chữ ký 1 đơn đã chốt = KHÓA ĐẶT CHỖ: flow|tên|SĐT|NGÀY.
// DANH TÍNH buổi hẹn = (người + NGÀY), KHÔNG phải (người + giờ-raw). Lý do:
//   - preferredTime là text BIẾN ĐỔI khi hội thoại làm rõ dần ("mai" → "10h sáng mai 18/06" → "2h chiều").
//     Nếu khóa theo raw text thì mỗi lần làm rõ/đổi giờ = chữ ký mới = ghi DÒNG TRÙNG. Khóa theo NGÀY →
//     mọi thay đổi GIỜ trong CÙNG ngày giữ nguyên chữ ký → tryWriteLeadIfReady UPDATE 1 dòng (1 người+1 ngày=1 dòng).
//   - Đổi NGÀY (đặt buổi khác hôm) hoặc đổi NGƯỜI mới ra chữ ký mới.
// CỐ Ý KHÔNG gồm service — hỏi-đổi-môn (giữ ngày cũ) không sinh đơn ma.
// Fallback preferredTime khi CHƯA có ngày tuyệt đối (đơn cửa-sổ "cuối tuần") — giữ hành vi cũ cho case đó.
// flow để phân biệt đơn fitness vs giai-co. Chỉ trả non-null khi đủ tên + SĐT + giờ (lead complete).
export function bookingSignature(info: KnownInfo, flow: Flow): string | null {
  if (!info.name || !info.phone || !info.preferredTime) return null;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const dateKey = appointmentDateKey(info.appointmentDate) ?? norm(info.preferredTime);
  return [flow, norm(info.name), norm(info.phone), norm(dateKey)].join("|");
}

// KH (sau khi đã chốt) muốn ĐẶT THÊM: môn khác / buổi khác / cho người thân.
// Cue rõ ràng để re-open funnel thu thập đơn mới thay vì ở lì retention.
const ADD_BOOKING_CUE =
  /(đặt|đăng\s*kí?|book|lấy|mua|cho\s*em|thêm)\s*(thêm|nữa|1\s*(buổi|gói|thẻ|suất)|cho\s*(con|bé|vợ|chồng|mẹ|bố|ba|người\s*thân|bạn|anh|chị|em))|thêm\s*(1\s*)?(buổi|gói|môn|thẻ|suất|người|dịch\s*vụ)|còn\s*(môn|dịch\s*vụ|gói)\s*(khác|nào)|đăng\s*kí?\s*(luôn\s*)?(cho|thêm)/i;

export function detectAddBookingIntent(message: string): boolean {
  if (!message) return false;
  return ADD_BOOKING_CUE.test(message);
}

// KH ĐỔI LỊCH (reschedule) đơn đã đặt: dời/đổi/chuyển sang giờ khác. KHÁC "đặt thêm" (add).
// Dùng để UPDATE dòng Sheets cũ thay vì tạo dòng mới.
// BẮT BUỘC danh từ lịch/giờ theo sau verb để né false-positive ("chuyển khoản", "đổi gói", "đổi ý").
const RESCHEDULE_CUE =
  /(đổi|dời|chuyển|lùi|hoãn)\s+(lịch|giờ|buổi|ngày|sang|qua|lại|thành|đến)|thay\s*vì|(hôm|bữa)\s*khác|sang\s+(hôm|ngày|thứ)|không\s+(đến|đi|qua|tới)\s+(được|nữa)|bận\s+(rồi|mất|quá)/i;

export function detectRescheduleIntent(message: string): boolean {
  if (!message) return false;
  return RESCHEDULE_CUE.test(message);
}

// KH đặt hộ NGƯỜI KHÁC (con/vợ/chồng/người thân/bạn...). Dùng để cho phép override
// name/phone của đơn mới (vốn store-first) khi sau chốt khách đăng ký cho người thân.
// CỐ Ý KHÔNG gồm anh/chị/em — đó là honorific KH tự xưng ("cho chị xem", "cho em hỏi"),
// không phải người thứ ba. Chỉ match quan hệ rõ ràng là NGƯỜI KHÁC.
const BENEFICIARY_CUE =
  /(cho|của)\s+(con|bé|cháu|vợ|chồng|mẹ|bố|ba\b|má|ông|bà|người\s*thân|bạn|đồng\s*nghiệp|gấu|người\s*yêu|2\s*(vợ\s*chồng|mẹ\s*con|bố\s*con))/i;

export function detectBeneficiaryCue(message: string): boolean {
  if (!message) return false;
  return BENEFICIARY_CUE.test(message);
}

/**
 * Tín hiệu CHẤN THƯƠNG CẤP TÍNH (giai-co) — vừa bị (<72h) do sự cố cụ thể KÈM dấu hiệu cấp
 * (sưng/nóng/không cử động nổi). Dùng để CORROBORATE classifier attribute=acute_injury trước khi
 * bật cờ sticky acuteInjuryHold — classifier (mini) hay nhầm đau cơ MÃN ("đau mỏi mấy nay",
 * "căng cứng vài tuần") thành cấp tính (bug L3/L4). Yêu cầu 2 tín hiệu đồng thuận = hardening parse,
 * KHÔNG phải thay LLM bằng regex (classification vẫn do LLM, đây chỉ là chốt chặn an toàn).
 */
export function detectAcuteInjury(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    (/(hôm\s*qua|hôm\s*nay|sáng\s*nay|chiều\s*nay|tối\s*nay|vừa\s*bị|mới\s*bị)/.test(m) &&
      /(đau|chấn|trẹo|sai\s*tư\s*thế|té|ngã|lật|bong\s*gân)/.test(m)) ||
    /(không\s*(cử\s*động|nhúc\s*nhích)\s*(nổi|được)?|sưng\s*vù|sưng\s*to|nóng\s*đỏ|sưng\s*nóng)/.test(m)
  );
}

export function detectFlowByKeyword(
  message: string,
  _previousFlow: Flow | null
): Flow | null {
  // Pain priority: ngay khi có cue đau cụ thể → giải cơ, bất kể fitness keyword
  if (PAIN_PRIORITY.test(message)) return "giai-co";

  const isGiaiCo = GIAI_CO_KEYWORDS.test(message);
  const isFitness = FITNESS_KEYWORDS.test(message);

  if (isGiaiCo && !isFitness) return "giai-co";
  if (isFitness && !isGiaiCo) return "fitness";
  return null;
}

/**
 * Quyết định có CẦN LLM phân loại flow hay không (dùng chung cho router + silentClassify).
 *   - keywordFlow === null → cần LLM (chưa rõ flow từ keyword).
 *   - CONFLICT "đau-trong-fitness": đang fitness ĐÃ chốt bộ môn mà tin lật keyword sang giai-co
 *     (có cue đau) → KHÔNG để regex tự quyết. Để LLM phân xử (no-regex rule): đau là 1 vấn đề
 *     cơ-xương MÃN khách muốn xử lý riêng → giai-co (trị liệu); đau chỉ là lý do/mục tiêu chọn
 *     môn tập → fitness. FITNESS-SERVICE LOCK ở buildNextState dùng llm.flow làm trọng tài cuối.
 */
export function needsFlowClassification(
  keywordFlow: Flow | null,
  previous: ConversationState,
): boolean {
  if (keywordFlow === null) return true;
  const committedFitness =
    previous.flow === "fitness" && previous.knownInfo.serviceType !== null;
  const engagedGiaiCo =
    previous.flow === "giai-co" && previous.knownInfo.painArea !== null;
  // Flip RỜI một flow đang engaged → KHÔNG để keyword lẻ tự quyết, xin LLM phân xử (no-regex):
  //   • fitness đã chốt môn ↔ keyword đòi giai-co (đau): cơn đau là vấn đề riêng hay lý do tập?
  //   • giai-co đã biết vùng đau ↔ keyword đòi fitness (vd câu follow-up có "thể thao"/"tập"/"gym"):
  //     khách thật sự đổi sang hỏi tập gym/hội viên, hay chỉ là follow-up của buổi trị liệu?
  if (keywordFlow === "giai-co" && committedFitness) return true;
  if (keywordFlow === "fitness" && engagedGiaiCo) return true;
  return false;
}

// ─────────────────────────────────────────────
// HONORIFIC DETECTION
// ─────────────────────────────────────────────

export function detectHonorific(
  message: string,
  previous: "anh" | "chị" | "anh/chị"
): "anh" | "chị" | "anh/chị" {
  const msg = message.toLowerCase();

  // Khách viết "anh/chị" → khách dùng dạng generic, giữ nguyên previous
  if (/anh\s*\/\s*ch(ị|i)/.test(msg)) return previous;

  // Boundary an toàn cho Unicode tiếng Việt: dùng start/end, whitespace hoặc dấu câu.
  // KHÔNG match "a" lẻ — quá nhiều false-positive ("a ơi", "a a a", filler).
  const boundary = "(^|[\\s,.!?:;()\\-/])";
  const tail     = "([\\s,.!?:;()\\-/]|$)";

  const isChi = new RegExp(`${boundary}(chị|chj)${tail}`).test(msg);
  if (isChi) return "chị";

  const isAnh = new RegExp(`${boundary}anh${tail}`).test(msg);
  if (isAnh) return "anh";

  return previous;
}

export function resolveHonorific(h: "anh" | "chị" | "anh/chị"): string {
  return h === "anh/chị" ? "anh/chị" : h;
}

// ─────────────────────────────────────────────
// HELPERS — đánh giá độ chín của slot
// ─────────────────────────────────────────────

/**
 * Fitness: coi là "đủ để evaluation" khi biết serviceType VÀ ít nhất 1 trong:
 *   - fitnessGoal (mục tiêu)
 *   - memberType
 *   - schedule
 *   - intent là selecting/ready (khách đã chọn cụ thể hoặc sẵn sàng chốt)
 *
 * Logic: chỉ biết serviceType chưa đủ — cần biết khách muốn gì
 * để tư vấn gói có narrative thay vì liệt kê giá thẳng.
 * NOTE: "compare" KHÔNG còn bypass — khai báo mục tiêu tập không đủ để show gói ngay.
 */
function fitnessReadyForEvaluation(info: KnownInfo, intent: Intent): boolean {
  // Khách đã commit time (preferredTime) → ready bất kể serviceType.
  // Bot có thể recommend service sau khi xin tên/SĐT — không cần stuck hỏi service.
  if (info.preferredTime !== null) return true;

  // BODY-GOAL + đã có chỉ số cơ thể (cao/nặng) → ĐỦ để tư vấn theo chuẩn rồi TỰ recommend môn.
  // KHÔNG bắt khách chọn môn trước (giảm cân → Gym+Zumba là bot tự đề xuất, không hỏi "muốn tập
  // môn nào"). Đây là lỗ hổng khiến khách cho cao/nặng mà bot vẫn kẹt discovery hỏi dồn: serviceType
  // null nhưng đã nắm goal + chỉ số là quá đủ để chuyển sang tư vấn.
  const BODY_GOALS = ["giam-mo", "tang-can", "giu-dang"];
  if (
    info.fitnessGoal !== null &&
    BODY_GOALS.includes(info.fitnessGoal) &&
    info.bodyStats !== null
  ) {
    return true;
  }

  if (info.serviceType === null) return false;

  // Chỉ khách chủ động chọn gói / sẵn sàng đăng ký → bypass context collection
  if (intent === "selecting" || intent === "ready") {
    return true;
  }

  // explore / compare: cần ít nhất 1 context slot (goal / memberType / schedule)
  // Ngăn bot nhảy vào show gói ngay khi khách chỉ vừa khai báo mục tiêu ("tăng cơ giảm mỡ")
  const hasGoal     = info.fitnessGoal !== null;
  const hasMember   = info.memberType !== null;
  const hasSchedule = info.schedule !== null;

  return hasGoal || hasMember || hasSchedule;
}

/**
 * Giải cơ: coi là "đủ để evaluation" khi biết painArea + painSpread.
 *
 * pastMethod (đã thử massage/cao/dầu chưa) KHÔNG còn là slot bắt buộc: hỏi nó là tra
 * khảo, không đẩy được sale (sale thật nghe "đau cổ" thì TƯ VẤN cơ chế + mời thử, không
 * khảo sát khách đã bôi cao chưa). Nếu khách tự kể phương pháp đã thử → vẫn extract để
 * làm contrast, nhưng KHÔNG chặn bước. 1 câu painSpread (lan/cố định) là đủ để cá nhân hóa
 * value rồi sang evaluation — đúng MẪU của GiaiCoAgent.
 */
function giaiCoReadyForEvaluation(info: KnownInfo, intent: Intent): boolean {
  if (info.painArea === null) return false;

  // Intent cao: khách chủ động chọn
  if (intent === "selecting" || intent === "ready") return true;

  // Khách đã đồng ý thử (có giờ cụ thể) → đủ để chuyển sang evaluation rồi commitment
  if (info.preferredTime !== null) return true;

  // Đủ sau MỘT lượt khai thác có hồi đáp: khách cho biết tính chất đau (lan/cố định) HOẶC
  // thời gian đau (lâu chưa). Discovery T1 đồng cảm + hỏi 1 câu hiểu tình trạng → khách đáp →
  // sang evaluation (giải thích cơ chế + value + mời TRẢI NGHIỆM mềm). KHÔNG ép 1 slot cứng.
  return info.painSpread !== null || info.painDuration !== null;
}

// ─────────────────────────────────────────────
// STAGE TRANSITION — Hard-coded FSM
// ─────────────────────────────────────────────

export function computeNextStage(
  currentStage: Stage,
  info: KnownInfo,
  intent: Intent,
  flow: Flow,
  llmSuggestedStage: Stage,
  turnCount: number = 0,
  // FUNNEL TL Fami: đã "chạm nỗi đau" chưa? (bot đã hỏi cao/nặng/số-kg, HOẶC khách đã đưa số liệu,
  // HOẶC đã biết thói quen/lịch sử). Với goal body-comp, discovery CHƯA xong nếu chưa probe nỗi đau.
  painProbed: boolean = false
): Stage {

  // Recovery / retention — giữ nguyên
  if (currentStage === "recovery" || currentStage === "retention") {
    return currentStage;
  }

  // Objection
  if (currentStage === "objection") {
    if (intent === "selecting" || intent === "ready") return "commitment";
    return "objection";
  }

  // Commitment
  if (currentStage === "commitment") {
    return "commitment";
  }

  // Opening → Discovery (hoặc xa hơn nếu slots đã đủ điều kiện)
  // Multi-step: nếu khách cung cấp đủ info ngay tin đầu, nhảy thẳng đến stage phù hợp
  // thay vì buộc phải đi qua discovery một lượt rỗng.
  // Slot tín hiệu rời opening: serviceType, painArea, fitnessGoal, memberType, schedule, preferredTime,
  // hoặc intent != explore.
  if (currentStage === "opening") {
    if (
      info.serviceType !== null ||
      info.painArea !== null ||
      info.fitnessGoal !== null ||
      info.memberType !== null ||
      info.schedule !== null ||
      info.preferredTime !== null ||
      intent !== "explore"
    ) {
      return computeNextStage("discovery", info, intent, flow, llmSuggestedStage, turnCount, painProbed);
    }
    // Anti-stuck: nếu turn ≥ 3 mà vẫn opening → đẩy về discovery để bot không lặp template chào.
    if (turnCount >= 3) {
      return "discovery";
    }
    return "opening";
  }

  // Discovery → Evaluation
  if (currentStage === "discovery") {
    const fitnessReady = flow === "fitness" && fitnessReadyForEvaluation(info, intent);
    const giaiCoReady  = flow === "giai-co" && giaiCoReadyForEvaluation(info, intent);

    if (fitnessReady || giaiCoReady) {
      // GUARD — tin đầu tiên (turnCount <= 1): giữ ở discovery NẾU chưa có thông tin cốt lõi.
      // Bypass guard khi slots cốt lõi đã đầy đủ (khách cung cấp hết 1 lần).
      // FUNNEL TL Fami: serviceType + GOAL-một-mình KHÔNG đủ để bỏ qua discovery — vẫn phải
      // KHAI THÁC NỖI ĐAU (cao/nặng/số kg) trước khi pitch InBody/gói. Chỉ coi là "front-load
      // đủ slot" (cho nhảy thẳng) khi khách đã cho thêm tín hiệu lịch/loại-thẻ/giờ cụ thể.
      const coreSlotsFilled =
        (flow === "giai-co" && info.preferredTime !== null) ||
        (flow === "fitness" &&
          info.serviceType !== null &&
          (info.memberType !== null || info.schedule !== null || info.preferredTime !== null));

      // Body-goal đã kèm chỉ số cơ thể NGAY tin đầu (front-load "giảm cân cao 1m7 nặng 80")
      // → ĐỦ để tư vấn theo chuẩn, KHÔNG giữ lại discovery hỏi lại cao/nặng (đã có) = lặp khó chịu.
      const bodyGoalWithStats =
        flow === "fitness" &&
        info.bodyStats !== null &&
        (info.fitnessGoal === "giam-mo" ||
          info.fitnessGoal === "tang-can" ||
          info.fitnessGoal === "giu-dang");

      if (
        turnCount <= 1 &&
        intent !== "selecting" &&
        intent !== "ready" &&
        !coreSlotsFilled &&
        !bodyGoalWithStats
      ) {
        return "discovery";
      }
      // ANTI-PREMATURE-COMMITMENT GUARD:
      // Khách nói "đăng ký gym" / "lấy yoga" → classifier hay nhầm thành intent=ready,
      // dẫn đến jump thẳng commitment trong khi bot CHƯA hỏi "đã tập X chưa".
      // Yêu cầu ít nhất 1 tín hiệu commit thật: preferredTime, name+phone, hoặc goal+schedule.
      const hasCommitSignal =
        info.preferredTime !== null ||
        (info.name !== null && info.phone !== null) ||
        (info.fitnessGoal !== null && info.schedule !== null);
      if (
        flow === "fitness" &&
        (intent === "selecting" || intent === "ready") &&
        !hasCommitSignal
      ) {
        console.log(`[stateMachine] guard: intent=${intent} nhưng chưa có commit signal → stay discovery`);
        return "discovery";
      }
      // Giải cơ: khách đã báo giờ + chủ động đặt lịch → thẳng commitment, skip evaluation pitch
      if (flow === "giai-co" && (intent === "selecting" || intent === "ready") && info.preferredTime !== null) {
        return "commitment";
      }
      // Fitness: khách chủ động chọn gói / đăng ký → thẳng commitment (đã pass guard)
      if (flow === "fitness" && (intent === "selecting" || intent === "ready")) {
        return "commitment";
      }
      // Fitness: khách báo giờ cụ thể (preferredTime) → skip InBody pitch, vào commitment
      // để xin tên/SĐT giữ slot. InBody là build-value tactic — không cần khi khách đã commit time.
      if (flow === "fitness" && info.preferredTime !== null) {
        console.log(`[stateMachine] fitness discovery → commitment (preferredTime=${info.preferredTime})`);
        return "commitment";
      }
      // FUNNEL — LẤY ĐỦ THÔNG TIN RỒI TƯ VẤN, KHÔNG TRA HỎI DỒN:
      // Goal body-comp (giảm/tăng cân, giữ dáng) mà MỚI biết mỗi mục tiêu → giữ ở discovery
      // để hỏi GỌN chiều cao/cân nặng 1 lượt, KHÔNG nhảy thẳng "đo InBody + sáng hay chiều".
      // Khách chủ động commit (selecting/ready), đã có giờ, hoặc đã có tên+SĐT → bỏ qua, không nài.
      const BODY_GOALS = ["giam-mo", "tang-can", "giu-dang"];
      const isBodyGoal = info.fitnessGoal !== null && BODY_GOALS.includes(info.fitnessGoal);
      // ĐỦ ĐỂ TƯ VẤN: với body-goal, thông tin CHỐT là CAO/NẶNG (bodyStats) — để đối chiếu bảng
      // chuẩn rồi tư vấn. pastMethod ("đã/chưa tập") KHÔNG thay được cao/nặng → KHÔNG để nó đẩy
      // qua InBody khi bot còn CHƯA kịp hỏi cao/nặng (lỗi thật: khách "tăng cân, chưa từng tập" →
      // bot nhảy InBody, bỏ qua cao/nặng). Anti-stuck turn≥5 (không phải 3): goal thường mới lộ
      // GIỮA discovery (sau "đã tập chưa"), cần chừa ≥1 lượt hỏi cao/nặng trước khi thả; khách
      // không cho số tới turn 5 thì mới tư vấn chung + mời đo InBody.
      const painExploredDeep =
        info.bodyStats !== null ||
        turnCount >= 5;
      if (
        flow === "fitness" &&
        isBodyGoal &&
        !painExploredDeep &&
        intent !== "selecting" &&
        intent !== "ready" &&
        info.preferredTime === null &&
        !(info.name !== null && info.phone !== null)
      ) {
        console.log(`[stateMachine] funnel: body-goal=${info.fitnessGoal} khai thác chưa đủ sâu (bodyStats=${info.bodyStats !== null} pastMethod=${info.pastMethod !== null} turn=${turnCount}) → stay discovery`);
        return "discovery";
      }
      // Fitness: mandatory Inbody funnel trước khi show gói
      if (flow === "fitness") {
        return "inbody";
      }
      return "evaluation";
    }
    return "discovery";
  }

  // Inbody → Evaluation (hoặc Commitment nếu intent rất cao)
  // Sau khi bot pitch Inbody 1 lần, lượt tiếp theo luôn chuyển sang show gói.
  // Khách nói "không cần đo" hay "cho xem gói" → evaluation
  // Khách nói "ok đăng ký luôn" → commitment
  if (currentStage === "inbody") {
    if (intent === "ready" || intent === "selecting") return "commitment";
    return "evaluation";
  }

  // Evaluation → Negotiation / Commitment
  if (currentStage === "evaluation") {
    // Giải cơ: commit khi khách đã cung cấp tên + SĐT — tức là evaluation pitch đã xảy ra xong
    if (flow === "giai-co" && info.name !== null && info.phone !== null) {
      console.log(`[stateMachine] giai-co evaluation → commitment (name/phone filled)`);
      return "commitment";
    }
    // Giải cơ: intent cao + báo giờ → skip thẳng commitment (khách chủ động đặt lịch)
    if (flow === "giai-co" && (intent === "selecting" || intent === "ready") && info.preferredTime !== null) {
      console.log(`[stateMachine] giai-co evaluation → commitment (high intent + preferredTime=${info.preferredTime})`);
      return "commitment";
    }

    // Fitness: khách đã báo giờ InBody (preferredTime filled) → commitment để hỏi tên/SĐT.
    // Evaluation pitch đã xảy ra ở turn trước — KHÔNG lặp lại. Song song với quy tắc giai-co ở trên.
    if (flow === "fitness" && info.preferredTime !== null) {
      console.log(`[stateMachine] fitness evaluation → commitment (preferredTime=${info.preferredTime})`);
      return "commitment";
    }

    // Fitness: đã có tên/SĐT → commitment
    if (flow === "fitness" && info.name !== null && info.phone !== null) {
      console.log(`[stateMachine] fitness evaluation → commitment (name/phone filled)`);
      return "commitment";
    }

    if (intent === "ready") return "commitment";

    // Fitness: chỉ vào negotiation khi khách chủ động chọn gói cụ thể
    if (intent === "selecting") return "negotiation";

    return "evaluation";
  }

  // Negotiation → Commitment
  if (currentStage === "negotiation") {
    if (intent === "ready" || intent === "selecting") return "commitment";
    // Khách đã báo giờ → commit (tránh lặp pitch). Áp dụng cho cả 2 flow.
    if (info.preferredTime !== null) {
      console.log(`[stateMachine] negotiation → commitment (preferredTime=${info.preferredTime})`);
      return "commitment";
    }
    return "negotiation";
  }

  return llmSuggestedStage;
}

// ─────────────────────────────────────────────
// TEMPERATURE
// ─────────────────────────────────────────────

export function computeTemperature(
  info: KnownInfo,
  intent: Intent,
  stage: Stage
): Temperature {
  if (intent === "ready" || stage === "commitment") return "hot";

  const filledSlots = Object.values(info).filter((v) => v !== null).length;

  if (filledSlots > 0 || intent === "compare" || intent === "selecting") {
    return "warm";
  }

  return "cold";
}

// ─────────────────────────────────────────────
// LLM CLASSIFICATION OUTPUT
// ─────────────────────────────────────────────

export interface LLMClassification {
  flow: Flow | null;
  llmStage: Stage;
  emotion: Emotion;
  intent: Intent;
  intentTopic: IntentTopic | null;
  /** Xưng hô KH tự nhận (anh/chị) — LLM classifier hiểu "a"/"c"/ngữ cảnh. null = chưa rõ. */
  honorific?: "anh" | "chị" | null;
  /** Phase 1: classifier output 3-trục. Optional để backward compat. */
  intentSignal?: import("./intent").IntentSignal | null;
  /** Multi-intent: secondary intents (max 2). Empty hoặc undefined = single-intent. */
  secondaryIntents?: import("./intent").IntentSignal[];
  /** Nước đi media chủ động classifier quyết turn này (xem [[MediaMove]]). */
  mediaMove?: MediaMove;
  extractedSlots: Partial<KnownInfo>;
  qrShown: boolean | null;
  mediaShown: boolean | null;
}

// ─────────────────────────────────────────────
// FULL STATE UPDATE
// ─────────────────────────────────────────────

export function buildNextState(
  previous: ConversationState,
  message: string,
  llm: LLMClassification
): ConversationState {
  // Xưng hô: lấy từ classifier (LLM hiểu "a"→anh, "c"→chị, ngữ cảnh) — KHÔNG regex.
  // Sticky: classifier cho giá trị mới thì cập nhật, không thì giữ previous.
  const honorific: "anh" | "chị" | "anh/chị" =
    llm.honorific === "anh" || llm.honorific === "chị"
      ? llm.honorific
      : previous.honorific;

  const keywordFlow = detectFlowByKeyword(message, previous.flow);
  let flow = keywordFlow ?? llm.flow ?? previous.flow;

  // GIAI-CO LOCK (đối xứng FITNESS-SERVICE LOCK): KH đang trong trị liệu giải cơ (ĐÃ biết vùng đau)
  // mà 1 keyword lẻ trong câu follow-up ("thể thao"/"tập"/"gym") đòi lật flow=fitness → KHÔNG để regex
  // tự quyết. Trọng tài là LLM (needsFlowClassification bật đúng case này → llm.flow là phán đoán THẬT):
  // Honor switch CHỈ khi khách nêu DỊCH VỤ FITNESS CỤ THỂ trong tin này (serviceType: gym/yoga/zumba/
  // bơi/pilates). KHÔNG tính fitnessGoal (quá generic, classifier hay ảo "duy trì sức khỏe" → nhả lock
  // sai), KHÔNG tin mỗi llm.flow="fitness" (đoán sai 1 câu mơ hồ như "làm xong có hết hẳn không").
  //   • có serviceType fitness → khách thật sự quay sang hỏi tập môn đó → TÔN TRỌNG switch.
  //   • else → câu "có hết hẳn không / cho xem ca giống tôi / 1 buổi bao nhiêu" là follow-up trị liệu
  //     → GIỮ giai-co (đừng văng sang báo giá gói gym, gửi ảnh gym).
  // Đặt TRƯỚC safety/post-surgery lock để các lock đó vẫn override sang fitness khi thật sự cần.
  // Giai-co STICKY: một khi đang trong luồng giải cơ (Hoa Sen), câu follow-up — kể cả hỏi tiện ích/
  // logistics ("đỗ ô tô được không", "làm bao lâu", "có tắm không") TRƯỚC khi kịp khai vùng đau —
  // KHÔNG được rò sang fitness (trả nhầm giờ/địa chỉ Fami). Chỉ nhả lock khi khách nêu RÕ 1 dịch vụ
  // fitness (switchedToFitnessSignal bên dưới). (Trước đây đòi painArea != null → leak khi khách hỏi
  // logistics trước lúc kể đau.)
  const engagedGiaiCo = previous.flow === "giai-co";
  const FITNESS_SERVICE_SLOTS = ["gym", "yoga", "zumba", "boi", "pilates", "full"];
  const extractedFitnessService =
    typeof llm.extractedSlots.serviceType === "string"
      ? llm.extractedSlots.serviceType.toLowerCase()
      : null;
  const switchedToFitnessSignal =
    extractedFitnessService !== null &&
    FITNESS_SERVICE_SLOTS.includes(extractedFitnessService);
  if (engagedGiaiCo && flow === "fitness" && !switchedToFitnessSignal) {
    console.log(
      `[stateMachine] giai-co lock: painArea=${previous.knownInfo.painArea} + flow đòi fitness nhưng không có dịch vụ fitness cụ thể (llm.flow=${llm.flow ?? "—"}, service=${llm.extractedSlots.serviceType ?? "—"}) → giữ flow=giai-co`,
    );
    flow = "giai-co";
  }

  // HEALTH-SAFETY FLOW LOCK: Nếu turn trước fire safety topic (ask_senior/postpartum/prenatal/post_surgery),
  // turn này dù có mention đau cơ (vd "khớp gối yếu", "cao huyết áp") vẫn STAY fitness flow.
  // Lý do: đang trong context tư vấn TẬP an toàn, KHÔNG phải đặt giải cơ.
  // ⚠️ CHỈ áp khi KHÔNG engaged giai-co: "context tập an toàn" chỉ tồn tại trong flow fitness. Nếu khách
  // đang trong trị liệu giải cơ (painArea đã biết), 1 câu lành tính bị classifier ẢO thành ask_senior_
  // safety (vd "làm xong có hết hẳn không", "làm có đau không") KHÔNG được kéo về fitness — người già/bà
  // bầu hỏi an toàn giải cơ vẫn là lead giai-co, agent giai-co tự xử lý chống chỉ định.
  const wasSafetyContext =
    previous.intentTopic === "ask_senior_safety" ||
    previous.intentTopic === "ask_postpartum_safety" ||
    previous.intentTopic === "ask_prenatal_safety" ||
    previous.intentTopic === "ask_post_surgery";
  if (wasSafetyContext && flow === "giai-co" && !engagedGiaiCo) {
    console.log(`[stateMachine] safety lock: previous=${previous.intentTopic} → giữ flow=fitness`);
    flow = "fitness";
  }

  // POST-SURGERY DETECTION: Tin nhắn có cue "phẫu thuật / mổ / đứt dây chằng / chấn thương phục hồi"
  // → bắt buộc flow=fitness (KHÔNG phải giai-co dù keyword "đau lưng/đầu gối" hit PAIN_PRIORITY).
  // Vì khách hỏi tư vấn TẬP phục hồi, không đặt lịch giải cơ.
  const postSurgeryCue =
    /(phẫu\s*thuật|mới\s*mổ|vừa\s*mổ|đứt\s*dây\s*chằng|chấn\s*thương|đang\s*phục\s*hồi|bác\s*sĩ\s*kêu\s*tập)/i;
  if (postSurgeryCue.test(message) && flow === "giai-co") {
    console.log(`[stateMachine] post-surgery cue → flow=fitness (override giai-co)`);
    flow = "fitness";
  }

  // FITNESS-SERVICE LOCK: KH đã chốt 1 bộ môn fitness (yoga/gym/zumba/bơi/pilates) mà turn này
  // CHỈ than đau (vd "tập yoga để thư giãn, lưng hay đau") → KHÔNG nhảy giai-co. Cơn đau là LÝ DO/
  // ngữ cảnh tập, KHÔNG phải request đặt giải cơ. Yoga/pilates còn thường được tập ĐỂ giảm đau lưng.
  // Vẫn cho switch nếu message NÊU RÕ dịch vụ giải cơ (massage/giải cơ/xoa bóp/VLTL...).
  const FITNESS_SERVICES_SET = ["gym", "yoga", "zumba", "boi", "pilates", "full"];
  const committedFitnessService =
    previous.flow === "fitness" &&
    previous.knownInfo.serviceType !== null &&
    FITNESS_SERVICES_SET.includes(previous.knownInfo.serviceType);
  const giaiCoServiceRequest =
    /(giải\s*cơ|massage|xoa\s*bóp|vật\s*lý\s*trị\s*liệu|ngâm\s*bồn|trigger|fascia|regenix)/i;
  if (flow === "giai-co" && committedFitnessService && !giaiCoServiceRequest.test(message)) {
    // Đã chốt bộ môn fitness + tin chỉ than đau (không nêu rõ dịch vụ giải cơ): KHÔNG để regex
    // tự quyết. Trọng tài là LLM (router bật needFlowClassification đúng case này → llm.flow là
    // phán đoán THẬT, không phải echo keyword):
    //   • llm.flow="giai-co" → khách nêu 1 cơn đau cơ-xương như vấn đề RIÊNG → TÔN TRỌNG pivot
    //     sang giải cơ (cross-sell trị liệu, giá trị KTV xử điểm kẹt — KHÔNG phải InBody/tập).
    //   • else (fitness/null) → đau là lý do/ngữ cảnh chọn môn (vd tập để đỡ đau) → giữ fitness.
    if (llm.flow !== "giai-co") {
      console.log(
        `[stateMachine] fitness-service lock: serviceType=${previous.knownInfo.serviceType} + than đau, llm.flow=${llm.flow ?? "—"}≠giai-co → giữ flow=fitness`,
      );
      flow = "fitness";
    } else {
      console.log(
        `[stateMachine] fitness-service: than đau + llm.flow=giai-co → pivot sang giải cơ (cross-sell trị liệu)`,
      );
    }
  }

  // Detect SERVICE SWITCH: KH đổi bộ môn giữa cuộc thoại.
  // Tín hiệu: LLM classifier extract serviceType MỚI khác serviceType hiện tại trong state.
  // Khi switch:
  //   - lock serviceType vào bộ môn mới (override pick() trong mergeSlots)
  //   - reset slots phụ thuộc service: fitnessGoal, memberType, schedule, durationMonths, sessionPackage
  //   - giữ name/phone/preferredTime (cross-service)
  //   - reset stage về opening để re-chạy discovery (hỏi "đã tập X chưa", mục tiêu...)
  // FALLBACK: nếu LLM classifier không extract serviceType, thử keyword detect (vd "yoga thôi").
  const extractedService =
    llm.extractedSlots.serviceType ?? detectServiceByKeyword(message);
  const FAMI_SERVICES = ["gym", "yoga", "zumba", "boi", "pilates", "full"];
  const normalizedExtracted =
    typeof extractedService === "string" ? extractedService.toLowerCase() : null;
  const switched =
    flow === "fitness" &&
    normalizedExtracted !== null &&
    FAMI_SERVICES.includes(normalizedExtracted) &&
    previous.knownInfo.serviceType !== null &&
    normalizedExtracted !== previous.knownInfo.serviceType
      ? normalizedExtracted
      : null;

  // Deterministic fallback: nếu LLM classifier không extract được name/phone
  // mà message có pattern "<tên> <sđt>" → trust regex (đặc biệt với tên lowercase
  // hoặc trùng từ vựng như "toàn", "an", "vui"... gpt-4o-mini hay miss).
  const inlineExtract = detectNamePhoneInline(message);

  // Context-aware standalone name: nếu inline không bắt được name (vd "Toàn mà")
  // VÀ context cho phép (bot vừa hỏi tên HOẶC state đã có phone nhưng thiếu name) →
  // thử parse message như tên đứng riêng.
  const llmName = llm.extractedSlots.name;
  const llmNameValid = !!(llmName && String(llmName).trim().length > 0);
  const inlineName = inlineExtract.name;
  let standaloneName: string | null = null;
  if (!llmNameValid && !inlineName) {
    const botAskedName = /\b(tên|sđt|name)\b/i.test(previous.lastBotReply ?? "");
    const phoneAlreadySet =
      previous.knownInfo.phone !== null && previous.knownInfo.name === null;
    if (botAskedName || phoneAlreadySet) {
      standaloneName = detectNameStandalone(message);
      if (standaloneName) {
        console.log(
          `[stateMachine] detectNameStandalone: "${message}" → name="${standaloneName}" (botAskedName=${botAskedName} phoneAlreadySet=${phoneAlreadySet})`,
        );
      }
    }
  }

  // Deterministic serviceType fallback: classifier (LLM) thỉnh thoảng MISS serviceType khi tin
  // gộp có cả lời chào ("alo e\na muốn tập gym\ngiảm mỡ") → tunnel-vision vào câu chào, để
  // serviceType=null → bot hỏi lại "bộ môn nào" dù khách ghi rõ "gym". Quét keyword để CHẮC CHẮN
  // bắt được bộ môn khi message ghi rõ. Guard so-sánh ("gym hay yoga") → KHÔNG khoá, để classifier
  // xử lý câu hỏi so sánh đúng (pickServiceType phía dưới vẫn validate giá trị hợp lệ).
  const isServiceCompare =
    /(gym|yoga|zumba|bơi|boi|pilates)\b[^.!?]{0,12}(với|hay|vs\.?|so\s*với|cái\s*nào|hoặc)/i.test(
      message,
    );
  const keywordServiceFallback = isServiceCompare
    ? null
    : detectServiceByKeyword(message);

  // Tái dùng guard chống-bịa-thời-gian cho CẢ giờ lẫn ngày (không thêm regex mới):
  // tin KHÔNG có bất kỳ cue thời gian nào → sanitize trả null → ngày cũng KHÔNG đáng tin (null)
  // → carry-forward giữ NGUYÊN ngày đã chốt. Chặn classifier bịa ngày từ câu vô thời gian ("ok luôn").
  const sanitizedTime = sanitizePreferredTime(llm.extractedSlots.preferredTime, message);
  const extractedSlotsAugmented = {
    ...llm.extractedSlots,
    // Chỉ override khi LLM không cho giá trị (null/undefined/empty).
    serviceType: llm.extractedSlots.serviceType ?? keywordServiceFallback,
    // llmName đã sanitize ở mapToClassification; inline/standalone là path TẤT ĐỊNH chưa qua sanitize
    // → bọc sanitizeName để "tên anh là Trung, sđt..." không leak "Là Trung" (đóng gap của 6d).
    name:
      llmNameValid
        ? llmName
        : (sanitizeName(inlineName ?? standaloneName ?? "") ?? null),
    phone:
      llm.extractedSlots.phone && String(llm.extractedSlots.phone).trim().length > 0
        ? llm.extractedSlots.phone
        : inlineExtract.phone,
    // Chống classifier bịa thứ/ngày từ range-giờ ("tối 7-9h" → "thứ 7 13/06"). Xem sanitizePreferredTime.
    preferredTime: sanitizedTime,
    // Ngày hẹn tuyệt đối (DD/MM/YYYY) do classifier resolve. Gate qua sanitizedTime để chống bịa ngày.
    appointmentDate: sanitizedTime === null ? null : (llm.extractedSlots.appointmentDate ?? null),
    // Vá gap classifier miss goal "lấy lại dáng" (mẹ bỉm) → giam-mo. Chỉ fallback khi LLM không cho goal.
    fitnessGoal: llm.extractedSlots.fitnessGoal ?? detectGoalByKeyword(message),
  };
  if (inlineExtract.name || inlineExtract.phone) {
    console.log(
      `[stateMachine] detectNamePhoneInline: name=${inlineExtract.name ?? "—"} phone=${inlineExtract.phone ?? "—"}`,
    );
  }

  let knownInfo = mergeSlots(previous.knownInfo, extractedSlotsAugmented);
  if (switched) {
    // fitnessGoal là mục tiêu CỦA NGƯỜI (giảm mỡ/tăng cơ/sức khỏe/thư giãn) → cross-service:
    // đổi gym→yoga KHÔNG đổi việc khách muốn giảm cân. GIỮ goal (post-merge: ưu tiên goal mới
    // trong tin này, else carry-over) để bot KHÔNG hỏi lại mục tiêu thừa.
    // Ngoại lệ: goal service-bound "hoc-boi" chỉ hợp lệ với bơi → reset nếu chuyển sang bộ môn khác.
    const mergedGoal = knownInfo.fitnessGoal;
    const goalStillValid =
      mergedGoal !== null && !(mergedGoal === "hoc-boi" && switched !== "boi");
    knownInfo = {
      ...knownInfo,
      serviceType: switched,
      fitnessGoal: goalStillValid ? mergedGoal : null,
      // memberType giữ (cross-service: HS/SV/gia đình không đổi theo bộ môn).
      schedule: null,
      durationMonths: null,
      sessionPackage: null,
    };
  }

  // ── FLOW-CHANGE RESET (limitation 3): đổi domain (fitness↔giai-co) là 1 đơn HOÀN TOÀN
  // khác (2 business, lịch hẹn riêng). GIỮ name/phone (cùng người), RESET mọi slot booking
  // còn lại — kể cả preferredTime (giờ hẹn fitness ≠ giờ hẹn giai-co). Tránh carry-over giờ cũ
  // làm isLeadComplete=true → ghi "đơn ma" ở flow mới + để funnel flow mới thu thập sạch.
  if (flow !== previous.flow) {
    knownInfo = {
      ...knownInfo,
      serviceType: flow === "fitness" ? knownInfo.serviceType : null,
      fitnessGoal: flow === "fitness" ? knownInfo.fitnessGoal : null,
      memberType: flow === "fitness" ? knownInfo.memberType : null,
      schedule: flow === "fitness" ? knownInfo.schedule : null,
      durationMonths: flow === "fitness" ? knownInfo.durationMonths : null,
      painArea: flow === "giai-co" ? knownInfo.painArea : null,
      painSpread: flow === "giai-co" ? knownInfo.painSpread : null,
      painDuration: flow === "giai-co" ? knownInfo.painDuration : null,
      pastMethod: flow === "giai-co" ? knownInfo.pastMethod : null,
      sessionPackage: flow === "giai-co" ? knownInfo.sessionPackage : null,
      // Reset giờ hẹn khi đổi flow — TRỪ khi turn này có tín hiệu thời gian rõ (khách
      // chủ động cho giờ cho dịch vụ mới ngay trong tin đổi flow).
      preferredTime: isPreferredTimeSpecific(extractedSlotsAugmented.preferredTime ?? null)
        ? knownInfo.preferredTime
        : null,
      // Ngày hẹn đi theo giờ hẹn: giữ nếu turn đổi-flow có giờ rõ, ngược lại reset (đơn dịch vụ mới).
      appointmentDate: isPreferredTimeSpecific(extractedSlotsAugmented.preferredTime ?? null)
        ? knownInfo.appointmentDate
        : null,
    };
  }

  // ── ĐẶT THÊM / ĐẶT HỘ (limitation 1) — sau chốt, KH mở 1 đơn MỚI ──
  // Vấn đề: name/phone/preferredTime của đơn 1 vẫn còn (store-first) → đơn mới "tưởng" đã đủ
  // → ghi dòng Sheets với DỮ LIỆU CŨ LẪN LỘN (tên người cũ + giờ cũ). Smoke test thật bắt được.
  // Nguyên tắc: đơn mới KHÔNG kế thừa slot đặt-chỗ của đơn cũ. Chỉ giữ slot NẾU classifier trích
  // được MỚI ngay turn này; còn lại = null → isLeadComplete=false → bot thu thập thêm rồi mới ghi
  // (thà chờ 1 turn còn hơn ghi sai). Đặt hộ người khác → reset cả name/phone (người mới).
  const isBeneficiary = previous.sheetsWritten === true && detectBeneficiaryCue(message);
  const isSelfAdd =
    previous.sheetsWritten === true && !isBeneficiary && detectAddBookingIntent(message);
  if (isBeneficiary || isSelfAdd) {
    // Per-slot: 1 slot CHỈ bị reset nếu giá trị hiện tại CHÍNH LÀ của 1 đơn ĐÃ ghi
    // (tức đang kế thừa nhầm từ đơn cũ). Nếu là giá trị MỚI (đang gom dần cho đơn mới qua
    // nhiều turn) → GIỮ. Nhờ vậy đơn người-thân tích lũy được name/phone/time qua các turn
    // mà không bị ghi nhầm dữ liệu người cũ. KHÔNG cần thêm state field.
    const normV = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const writtenSigs = previous.bookingsWritten ?? [];
    const slotUsedInWritten = (val: string | null, idx: number) =>
      val !== null && writtenSigs.some((sig) => sig.split("|")[idx] === normV(val));
    const exFresh = (v: unknown): string | null =>
      typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

    // sig = flow|name|phone|NGÀY → idx 1=name, 2=phone, 3=ngày-key (xem bookingSignature).
    // Slot đặt-chỗ = (giờ + ngày). Đơn cũ còn dính nếu NGÀY hiện tại khớp 1 chữ ký đã ghi
    // (hoặc đơn cửa-sổ cũ khóa theo preferredTime). Dính → reset CẢ giờ lẫn ngày về giá trị fresh turn này.
    const dateKeyNow = appointmentDateKey(knownInfo.appointmentDate);
    const bookingInherited =
      (dateKeyNow !== null &&
        writtenSigs.some((sig) => sig.split("|")[3] === normV(dateKeyNow))) ||
      slotUsedInWritten(knownInfo.preferredTime, 3);
    if (bookingInherited) {
      knownInfo = {
        ...knownInfo,
        preferredTime: exFresh(extractedSlotsAugmented.preferredTime),
        appointmentDate: exFresh(extractedSlotsAugmented.appointmentDate),
      };
    }
    if (isBeneficiary) {
      const name = slotUsedInWritten(knownInfo.name, 1)
        ? exFresh(extractedSlotsAugmented.name)
        : knownInfo.name;
      const phone = slotUsedInWritten(knownInfo.phone, 2)
        ? exFresh(extractedSlotsAugmented.phone)
        : knownInfo.phone;
      knownInfo = { ...knownInfo, name, phone };
      console.log(
        `[stateMachine] đặt hộ người khác → đơn mới gom: name=${name ?? "(chờ)"} phone=${phone ?? "(chờ)"} time=${knownInfo.preferredTime ?? "(chờ)"}`,
      );
    } else {
      console.log(`[stateMachine] đặt thêm (cùng người) → giờ đơn mới: ${knownInfo.preferredTime ?? "(chờ)"}`);
    }
  }

  // ── Multi-service far-context: tích lũy MỌI bộ môn KH từng quan tâm ──
  // Gộp: services trước đó + môn quét từ message + focus serviceType hiện tại.
  // Khi switch service → KHÔNG xóa lịch sử (vẫn nhớ các môn cũ để tư vấn song song).
  const servicesInterested = (() => {
    const set = new Set(previous.servicesInterested ?? []);
    for (const s of collectServices(message)) set.add(s);
    const focus = knownInfo.serviceType;
    if (focus && focus !== "full") set.add(focus);
    return [...set];
  })();

  // ── POST-CLOSE STAGE (retention vs đơn thứ 2) ──
  // Sau khi ≥1 đơn đã ghi (sheetsWritten), MẶC ĐỊNH vào retention (concierge). Ghi Sheets
  // KHÔNG phụ thuộc stage — tryWriteLeadIfReady chạy mỗi turn, dedup theo bookingSignature,
  // nên đơn 2 (đổi giờ/môn/người) vẫn được ghi dù đang ở retention. Concierge GATE tự thu thập
  // info đơn mới + xác nhận tự nhiên (xem prefixBuilder retention branch).
  //
  // CỐ Ý KHÔNG re-open funnel (discovery) khi "đặt thêm": vì slot đơn 1 còn đầy
  // (name+phone+preferredTime) → computeNextStage sẽ nhảy thẳng commitment và xác nhận lại
  // ĐƠN CŨ thay vì hỏi đơn mới. Để retention concierge xử lý mượt hơn (giống sale thật).
  //
  // inFunnel2 = turn NGAY SAU chốt mà KH còn sửa/bổ sung đơn (vd đổi giờ) → giữ funnel để
  // chốt lại + ghi bản cập nhật, rồi mới rơi về retention.
  const closedBefore = previous.sheetsWritten === true;
  const bookingsWritten = previous.bookingsWritten ?? [];
  const curSig = bookingSignature(knownInfo, flow);
  const curBookingWritten = curSig !== null && bookingsWritten.includes(curSig);
  const FUNNEL_STAGES: Stage[] = ["discovery", "inbody", "evaluation", "negotiation", "commitment"];
  const inFunnel2 = closedBefore && FUNNEL_STAGES.includes(previous.stage);

  // ── RESCHEDULE (limitation 2): sau chốt, KH ĐỔI giờ (không phải đặt thêm) → giữ giờ CŨ
  // để tryWriteLeadIfReady UPDATE đúng dòng Sheets thay vì append dòng trùng.
  // Điều kiện: đã chốt + giờ thay đổi + cue "đổi/dời" + KHÔNG phải "đặt thêm".
  const oldTime = previous.knownInfo.preferredTime;
  const timeChanged =
    oldTime !== null && knownInfo.preferredTime !== null && knownInfo.preferredTime !== oldTime;
  const rescheduleFromTime =
    closedBefore &&
    timeChanged &&
    detectRescheduleIntent(message) &&
    !detectAddBookingIntent(message) &&
    flow === previous.flow
      ? oldTime
      : null;

  const baseStage: Stage =
    flow !== previous.flow ? "opening"               // đổi domain (fitness↔giai-co) → funnel mới
      : !closedBefore ? (switched ? "opening" : previous.stage) // trước chốt: hành vi cũ
      : inFunnel2 && !curBookingWritten ? previous.stage // ngay sau chốt, KH còn sửa đơn → funnel chốt lại + ghi
      : "retention";                                 // mặc định sau chốt: concierge (nhận đặt thêm tự nhiên)

  let intent = llm.intent;

  // DETERMINISTIC INTENT GUARD — "ok" nhiễu: 4o-mini đôi khi classify affirmation thuần ("ok"/"ừ"/
  // "được") thành `explore` dù khách đang ĐỒNG Ý lời MỜI THỬ/InBody của bot → funnel đứng. Khi tin
  // CHỈ là 1 affirmation thuần VÀ bot vừa mời thử 1 buổi / đo InBody / trải nghiệm → bump explore→
  // selecting để tiến. Bảo thủ: KHÔNG bump lên `ready`; KHÔNG đụng nếu LLM đã selecting/ready/compare;
  // FSM vẫn có guard commit-signal trước khi vào commitment (xem computeNextStage). Đúng rule classifier L587-588.
  const bareAffirmation =
    /^(ok|oke|okie|okê|okay|uh|uhm|ừ|ừm|um|vâng|dạ|đồng\s*ý|được|duoc|vang)\s*(em|ạ|a|nhé|nha|vâng|được|luôn|đi|thôi|nhỉ)?\s*[.!,]?$/i;
  const prevInvitedTrial =
    /(thử\s*1\s*buổi|thử\s*miễn\s*phí|đo\s*inbody|trải\s*nghiệm|ghé\s*thử|có\s*muốn\s*(thử|đo|ghé))/i;
  if (
    intent === "explore" &&
    bareAffirmation.test((message ?? "").trim()) &&
    prevInvitedTrial.test(previous.lastBotReply ?? "")
  ) {
    console.log(`[stateMachine] intent guard: bare "${message.trim()}" sau lời mời thử → explore→selecting`);
    intent = "selecting";
  }

  // turnCount: conversation-wide — KHÔNG reset khi flow đổi.
  // Dùng cho greeting decision (đã chào ở turn 1 rồi thì các turn sau dùng "Dạ vâng").
  const turnCount = previous.turnCount + 1;
  // flowTurnCount: per-flow — reset về 1 khi flow đổi.
  // Dùng cho anti-loop guards / discovery guard trong flow hiện tại.
  const flowTurnCount = flow !== previous.flow ? 1 : (previous.flowTurnCount ?? 0) + 1;

  // FUNNEL TL Fami — đã "chạm nỗi đau" chưa (cho discovery gate goal body-comp)? KHÔNG regex:
  //  (a) bot đã hỏi nỗi đau lượt trước  → so id template TẤT ĐỊNH (ask_pain_after_goal_*), id mình kiểm soát
  //  (b) khách đã khai chỉ số cơ thể     → slot bodyStats (classifier/LLM trích, không bắt số bằng regex)
  //  (c) đã biết thói quen/lịch sử tập    → slot pastMethod
  const botAskedPain = (previous.lastTemplateId ?? "").startsWith("ask_pain_after_goal");
  const gaveBodyStats = knownInfo.bodyStats !== null;
  const painProbed = botAskedPain || gaveBodyStats || knownInfo.pastMethod !== null;

  // SAFETY topics covered — sticky union toàn cuộc thoại. Tín hiệu từ LLM CLASSIFIER (intentTopic
  // của lượt TRƯỚC), KHÔNG regex bóc text reply. Lượt trước classifier nhận diện chủ đề an toàn nào
  // (postpartum/prenatal/...) tức bot vừa trấn an chủ đề đó → nhớ luôn để template KHÔNG bắn lại
  // NGUYÊN VĂN đoạn trấn an dài ở lượt sau (lỗi HARD-LOOP lộ máy) — nhường LLM trả lời ngắn, sát.
  const SAFETY_TOPIC_BY_INTENT: Record<string, string> = {
    ask_postpartum_safety: "postpartum",
    ask_prenatal_safety: "prenatal",
    ask_senior_safety: "senior",
    ask_post_surgery: "post_surgery",
    ask_teen_safety: "teen",
  };
  const safetyTopicsCovered = (() => {
    const set = new Set(previous.safetyTopicsCovered ?? []);
    const prevSafety = SAFETY_TOPIC_BY_INTENT[previous.intentTopic ?? ""];
    if (prevSafety) set.add(prevSafety);
    return [...set];
  })();

  // Sticky acute-injury hold: bật khi classifier báo acute_injury VÀ message có tín hiệu cấp thật
  // (detectAcuteInjury) — corroborate 2 tín hiệu để chặn classifier nhầm đau cơ MÃN thành cấp (bug L3/L4).
  // 1 lần bật thì giữ CẢ các turn sau (KH hỏi "khi nào qua được" / cảm ơn) → bot không rơi lại funnel.
  const acuteInjuryHold =
    previous.acuteInjuryHold === true ||
    (llm.intentSignal?.attribute === "acute_injury" && detectAcuteInjury(message));

  // Sticky corporate hold: KH là công ty/doanh nghiệp → giữ cờ để các turn sau (hỏi giá/1 người)
  // không rơi về báo giá lẻ retail. Dùng output classifier (KHÔNG regex).
  const corporateHold =
    previous.corporateHold === true ||
    llm.intentSignal?.attribute === "corporate" ||
    llm.intentTopic === "ask_corporate";

  const stage = computeNextStage(
    baseStage,
    knownInfo,
    intent,
    flow,
    llm.llmStage,
    flowTurnCount,  // dùng flowTurnCount cho discovery guard (relative đến flow hiện tại)
    painProbed
  );

  const temperature = computeTemperature(knownInfo, intent, stage);
  const emotion = llm.emotion;

  const qrShown    = llm.qrShown    ?? previous.qrShown;
  const mediaShown = llm.mediaShown ?? previous.mediaShown;

  return {
    flow,
    stage,
    temperature,
    emotion,
    intent,
    intentTopic: llm.intentTopic,
    intentSignal: llm.intentSignal ?? null,
    secondaryIntents: llm.secondaryIntents ?? [],
    mediaMove: llm.mediaMove ?? "none",
    honorific,
    knownInfo,
    turnCount,
    flowTurnCount,
    qrShown,
    mediaShown,
    mediaShownKeys: previous.mediaShownKeys ?? [],
    sheetsWritten: previous.sheetsWritten,
    bookingsWritten,
    servicesInterested,
    rescheduleFromTime,
    lastBotReply: previous.lastBotReply,
    // Track user message của turn TRƯỚC (≠ current `message`). Khi turn N+1 gọi, sẽ trở thành "previous" user message.
    // Workflow set lastUserMessage = current message ở step lưu state, sau khi buildNextState chạy xong.
    lastUserMessage: previous.lastUserMessage,
    askedHistory: previous.askedHistory ?? [],
    mentionedFacts: previous.mentionedFacts ?? [],
    safetyTopicsCovered,
    acuteInjuryHold,
    corporateHold,
    // lastTemplateId / recentBotReplies: được cập nhật ở updateStateAfterReply (sau khi có reply),
    // KHÔNG đổi trong buildNextState → carry-forward để không mất khi save nextState giữa chừng.
    lastTemplateId: previous.lastTemplateId ?? null,
    recentBotReplies: previous.recentBotReplies ?? [],
  };
}

// ─────────────────────────────────────────────
// DEFAULT STATE
// ─────────────────────────────────────────────

export const DEFAULT_STATE: ConversationState = {
  flow: "fitness",
  stage: "opening",
  temperature: "cold",
  emotion: "neutral",
  intent: "explore",
  intentTopic: null,
  intentSignal: null,
  secondaryIntents: [],
  mediaMove: "none",
  honorific: "anh/chị",
  knownInfo: {
    name: null,
    phone: null,
    serviceType: null,
    memberType: null,
    durationMonths: null,
    schedule: null,
    fitnessGoal: null,
    bodyStats: null,
    gender: null,
    painArea: null,
    painSpread: null,
    painDuration: null,
    pastMethod: null,
    sessionPackage: null,
    preferredTime: null,
    appointmentDate: null,
  },
  turnCount: 0,
  flowTurnCount: 0,
  qrShown: false,
  mediaShown: false,
  mediaShownKeys: [],
  sheetsWritten: false,
  bookingsWritten: [],
  servicesInterested: [],
  rescheduleFromTime: null,
  askedHistory: [],
  mentionedFacts: [],
  safetyTopicsCovered: [],
  acuteInjuryHold: false,
  corporateHold: false,
  lastTemplateId: null,
  recentBotReplies: [],
};