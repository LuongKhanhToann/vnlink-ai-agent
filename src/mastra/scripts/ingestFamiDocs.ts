/**
 * ingestFamiDocs.ts — nạp 2 tài liệu Fami (đã LÀM SẠCH cho khách) vào RAG docStore.
 *
 * Nguồn: 2 Google Doc của chủ ("tài liệu chung" + "tác dụng từng bộ môn"). Đã LỌC BỎ phần
 * chiến lược NỘI BỘ (định vị đòn bẩy, phễu chuyển đổi, mô hình đa cấp, số liệu dân số/doanh thu,
 * "AI Agent chiến lược") — chỉ giữ thông tin cơ sở + tác dụng/đối tượng từng bộ môn dùng được
 * cho khách. Chi tiết chiến lược/dinh dưỡng đã chắt lọc thẳng vào prompt (engine/gemma/prompt.ts).
 *
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/ingestFamiDocs.ts
 * Idempotent: xoá bản cũ trùng TÊN rồi nạp lại → chạy nhiều lần không nhân đôi.
 */
import "dotenv/config";
import { ingestDoc, listDocs, deleteDoc } from "../lib/docStore";

const DOCS: { title: string; category: string; text: string }[] = [
  {
    title: "Fami Fitness Vĩnh Yên — thông tin cơ sở & dịch vụ",
    category: "chung",
    text: `TRUNG TÂM FAMI FITNESS & YOGA CENTER VĨNH YÊN

Thành lập năm 2014. Địa chỉ: 32A Nguyễn Chí Thanh, phường Vĩnh Phúc (Vĩnh Yên cũ), tỉnh Phú Thọ. Tổng diện tích sàn 3.500m2, 3 tầng. Giờ hoạt động 5h00–20h00 hàng ngày; khung giờ cao điểm 5h–7h và 17h–19h, thời gian còn lại thấp điểm.

TẦNG 1: Khu bể bơi 4 mùa duy nhất tại Vĩnh Yên — bể người lớn 400m2, bể trẻ em riêng 70m2, khu vực hướng dẫn học bơi trên cạn 330m2, khu tắm tráng thay đồ 100m2. Kèm khu ăn sáng & cafe, khu tư vấn dinh dưỡng, khu lễ tân.

TẦNG 2: Khu Gym với đầy đủ máy chạy, giàn tập đa năng, máy tập ngực…; sân tập ngoài trời 300m2 có mái che. Phòng Pilates lớn (6 máy Reformer tower, 1 máy Cadillac, 6 máy Wunda Chair, 6 máy Ladder Barrel) và phòng Pilates nhỏ (7 máy tower).

TẦNG 3: Phòng Yoga 300m2 phục vụ 40–60 hội viên/ca, có đầy đủ vòng, bóng, gạch, dây và hệ thống dây tập yoga bay. Phòng Zumba 270m2 phục vụ 40–50 hội viên/ca.

CÁC DỊCH VỤ: Gym theo tháng/3/6/12 tháng; Gym cùng HLV theo nhóm hoặc PT 1-1; Bơi và dạy bơi 4 mùa; Yoga (lớp cộng đồng, giáo viên người Ấn Độ, 4 ca/ngày); Zumba (giáo viên Ấn Độ, 2 ca/ngày); Pilates (lớp 1:1, nhóm 1:3, nhóm 1:7 — triển khai từ 12/2024); giải cơ sâu / giải cơ thể thao hỗ trợ phục hồi cơ xương khớp; tư vấn dinh dưỡng; tập luyện điều chỉnh tư thế cùng HLV.

TIỆN ÍCH: phòng xông hơi, tủ đồ có khoá, phòng tắm nước nóng riêng nam/nữ, điều hoà, wifi miễn phí; có HLV nữ; có trông bé khi bố/mẹ tập. Gửi xe máy miễn phí, ô tô thu phí. Thanh toán chuyển khoản hoặc quẹt thẻ.`,
  },
  {
    title: "Fami — Tác dụng & đối tượng từng bộ môn",
    category: "fitness",
    text: `TÁC DỤNG & ĐỐI TƯỢNG PHÙ HỢP CỦA TỪNG BỘ MÔN

BƠI LỘI: Hệ thống bể bơi 4 mùa tập luyện quanh năm. Vận động dưới nước giúp giảm tải hoàn toàn áp lực lên hệ xương khớp; đốt calo cực kỳ hiệu quả nhưng không gây mệt mỏi quá sức. Phù hợp: người béo phì lâu năm, mỡ nội tạng cao, đang đau mỏi cơ xương khớp do gánh nặng trọng lượng, ngại phòng tập tạ nặng nề; cũng phù hợp trẻ em và người muốn học bơi bài bản.

GIẢI CƠ SÂU / GIẢI CƠ THỂ THAO: Liệu pháp mang tính y học thể thao, hỗ trợ phục hồi vận động cho cơ xương khớp; mang lại cảm giác nhẹ người, thư giãn tức thì ngay sau 1 buổi; xử lý đúng vùng cơ rệu rã, căng cứng, đau mỏi vai gáy. Phù hợp: người đau mỏi cơ xương khớp mãn tính, dân văn phòng ngồi nhiều ít vận động.

GYM: Hệ thống máy móc hiện đại (máy chạy, giàn tập đa năng, máy tập ngực); không gian rộng. Tác dụng cốt lõi không phải "ép xác" mà là vận động để phá vỡ ách tắc cơ thể, kích hoạt lại hệ trao đổi chất. Có HLV cá nhân theo sát. Phù hợp: người muốn giảm cân/giảm mỡ, tăng cân, tăng cơ, rèn thể lực; nhóm 18–50 tuổi.

YOGA: Giáo viên người Ấn Độ trực tiếp đứng lớp, có lớp cơ bản cho người mới. Điều hoà nhịp thở, phục hồi thể trạng suy nhược, giảm căng thẳng, hỗ trợ người mất ngủ, trào ngược dạ dày; cải thiện dẻo dai. Phù hợp: người lớn tuổi (45–70), phụ nữ, người căng thẳng cần thư giãn.

PILATES: Máy chuyên nghiệp (Reformer, Cadillac, Wunda Chair, Ladder Barrel); tập 1:1 với HLV hoặc lớp nhóm nhỏ. Tập trung điều chỉnh lại cấu trúc tư thế cơ thể, làm khoẻ nhóm cơ lõi. Phù hợp: người sai tư thế do mang gánh nặng trọng lượng lâu năm, người cần phương pháp tập an toàn, hiện đại.

TRIẾT LÝ CHUNG: Kết hợp VẬN ĐỘNG và DINH DƯỠNG tế bào để cân bằng chuyển hoá, giảm mỡ bền vững, chống tái béo. Sau khi đo InBody (đo tỷ lệ mỡ/cơ/nước), chuyên viên tư vấn dinh dưỡng chuyên sâu phù hợp thể trạng từng khách — như một bước nâng cấp để bảo vệ thành quả tập luyện, không mang tính ép mua.`,
  },
];

async function main() {
  const existing = await listDocs();
  for (const d of DOCS) {
    // Xoá mọi bản cũ trùng tên để chạy lại không nhân đôi.
    for (const old of existing.filter((e) => e.title === d.title)) {
      await deleteDoc(old.id);
      console.log(`  (xoá bản cũ #${old.id} "${old.title}")`);
    }
    const r = await ingestDoc(d);
    console.log(`✓ Nạp "${d.title}" [${d.category}] → doc #${r.id}, ${r.chunks} đoạn`);
  }
  console.log("\nDanh sách tài liệu hiện có:");
  for (const m of await listDocs()) {
    console.log(`  #${m.id} · ${m.title} · [${m.category}] · ${m.chunk_count} đoạn`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Lỗi nạp tài liệu:", e);
  process.exit(1);
});
