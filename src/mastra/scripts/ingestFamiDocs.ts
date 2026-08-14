/**
 * ingestFamiDocs.ts — nạp 3 tài liệu Fami (Vinalink gửi) vào RAG docStore, ĐẦY ĐỦ 100%.
 *
 * Yêu cầu của chủ: bot phải ĐỌC & HIỂU 100% nội dung 3 file. Nên ở đây nạp NGUYÊN nội dung
 * (kể cả phần định vị/chiến lược/mô hình kinh doanh) — chỉ thêm 1 dòng GHI CHÚ NỘI BỘ đầu tài
 * liệu chiến lược để bot dùng làm định hướng, không đọc nguyên văn mô hình đa cấp cho khách vãng
 * lai (trừ khi khách hỏi thẳng về cơ hội kinh doanh/hợp tác). Fact khách-facing (giá, giờ, tác
 * dụng bộ môn, khuyến mãi, gói giảm cân) đã đồng thời chắt lọc vào prompt + bảng giá.
 *
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/ingestFamiDocs.ts
 * Idempotent: xoá mọi bản cũ trùng tên (kể cả tên cũ đợt trước) rồi nạp lại.
 */
import "dotenv/config";
import { ingestDoc, listDocs, deleteDoc } from "../lib/docStore";

const INTERNAL_NOTE =
  "(GHI CHÚ NỘI BỘ cho tư vấn viên: dùng tài liệu này để HIỂU định hướng và tư vấn đúng nhu cầu khách. " +
  "KHÔNG đọc nguyên văn phần chiến lược/định vị/mô hình kinh doanh cho khách; chỉ nói về cơ hội kinh doanh/hợp tác khi khách HỎI THẲNG.)\n\n";

// Tên bản cũ (đợt trước) để dọn, tránh trùng lặp.
const OLD_TITLES = [
  "Fami Fitness Vĩnh Yên — thông tin cơ sở & dịch vụ",
  "Fami — Tác dụng & đối tượng từng bộ môn",
];

const DOCS: { title: string; category: string; text: string }[] = [
  {
    title: "Fami — Tổng quan, định vị & mô hình kinh doanh (tài liệu 1)",
    category: "chung",
    text:
      INTERNAL_NOTE +
      `TỔNG QUAN VỀ TRUNG TÂM FAMI FITNESS

PHẦN 1 — ĐỊNH VỊ, KHÁCH HÀNG MỤC TIÊU, CHIẾN LƯỢC BÁN HÀNG

1. Định vị thương hiệu: "Fami Fitness — Trung tâm Vận động và Tư vấn Dinh dưỡng, Kiểm soát cân nặng và Cân bằng chuyển hóa". Bản chất: không kinh doanh cho thuê thiết bị thể hình mà kinh doanh "Sự chuyển đổi toàn diện". Vận động là điều kiện cần (phá vỡ ách tắc cơ thể, kích hoạt trao đổi chất), Dinh dưỡng tế bào là điều kiện đủ (tái tạo, phục hồi, duy trì kết quả). Giá trị cốt lõi: giáo dục khách hiểu Vận động và Dinh dưỡng là hai bánh răng không thể tách rời; nâng cao nhận thức y học thường thức để khách làm chủ sức khỏe trọn đời.

2. Khách hàng mục tiêu: người gặp "nỗi đau kép" — thừa cân (mất thẩm mỹ) và rối loạn chuyển hóa (suy kiệt bên trong). Pain points: béo phì lâu năm, mỡ nội tạng cao, từng giảm cân sai cách (nhịn ăn, thuốc giảm cân) gây suy nhược, mất ngủ, trào ngược, mỡ máu, đau mỏi cơ xương khớp do gánh nặng trọng lượng. Tâm lý phòng thủ: khó tin lời hứa "giảm x cân trong y ngày", sợ tập cường độ cao, sợ chấn thương, sợ mệt. Khao khát: lấy lại tự tin ngoại hình, cơ thể nhẹ nhõm, ngủ ngon, hết đau nhức, phương pháp khoa học không tái béo. Khi lột xác thành công, khách trở thành bằng chứng sống thu hút người quen tới trung tâm.

3. Chiến lược phễu chuyển đổi (4 giai đoạn):
- Giai đoạn 1 — Thu hút bằng "phễu dịch vụ mềm" (rào cản thấp): Phễu Bơi lội trị liệu (vận động dưới nước, giảm tải xương khớp, đốt calo không mệt quá sức); Phễu Giải cơ sâu/giải cơ thể thao (thư giãn tức thì sau 1 buổi, xử đúng chỗ đau mỏi vai gáy); Phễu Tập luyện trợ giá (mua Thẻ Năm tặng 2 tháng tập nhóm nhỏ cùng HLV, hoặc mua Thẻ Năm được mua gói PT 1:1 giá ưu đãi).
- Giai đoạn 2 — Trải nghiệm & bẻ gãy niềm tin cũ: coach (và AI khi nhắn tin) đồng hành, giải thích cơ chế sinh lý (vì sao bơi xong đói, giải cơ xong nhẹ người); chuyển tư duy "tập để giảm cân" sang "vận động để thông mạch, ăn đúng để giảm mỡ".
- Giai đoạn 3 — Chốt sales dinh dưỡng & dòng tiền thụ động: dựa trên chỉ số InBody, coach tư vấn hệ vi sinh đường ruột và enzyme quyết định cân nặng; kê "phác đồ" kết hợp hệ sinh thái dinh dưỡng Vinalink — như một nâng cấp tất yếu để giữ thành quả, không ép mua.
- Giai đoạn 4 — Kiến tạo tín đồ thương hiệu: khách đạt body như ý + có nền tảng kiến thức, tự hào lối sống mới, tự giới thiệu bạn bè người thân.

PHẦN 2 — THÔNG TIN CHUNG DỰ ÁN FAMI FITNESS VĨNH YÊN
Thành lập 2014, địa chỉ 32A Nguyễn Chí Thanh, phường Đống Đa, TP Vĩnh Yên, Vĩnh Phúc (sau sáp nhập 01/07/2025 thuộc phường Vĩnh Phúc, tỉnh Phú Thọ). Tổng diện tích sàn 3.500m2.
- Tầng 1 (1.400m2): bể bơi bốn mùa DUY NHẤT Vĩnh Yên — bể người lớn 400m2, bể trẻ em 70m2, khu hướng dẫn học bơi 330m2, khu tắm tráng thay đồ 100m2; khu ăn sáng & cafe 300m2; khu tư vấn dinh dưỡng 50m2; văn phòng & phòng họp 150m2; lễ tân & phụ trợ 100m2.
- Tầng 2 (1.300m2): khu Gym 800m2 (máy chạy, giàn tập đa năng, máy tập ngực…); phòng Pilates 150m2 (6 máy Reformer tower, 1 Cadillac, 6 Wunda Chair, 6 Ladder Barrel); khu phụ trợ 50m2; sân tập ngoài trời 300m2 có mái che.
- Tầng 3 (700m2): phòng Yoga 300m2 (phục vụ 40-60 khách), phòng Zumba 270m2 (phục vụ 40-50 khách), hành lang & phụ trợ 150m2.
Giờ hoạt động 5h00–20h00 hàng ngày; cao điểm 5h-7h và 17h-19h, còn lại thấp điểm.
Dịch vụ & giá cơ bản (có bảng giá chi tiết riêng): Gym theo tháng/3/6/12; Gym cùng HLV nhóm hoặc PT 1-1; bơi & dạy bơi 4 mùa; Yoga (3-4 ca/ngày, lớp cộng đồng); Pilates tập 1-1 hoặc nhóm nhỏ; giải cơ sâu/giải cơ thể thao; tư vấn dinh dưỡng; tập điều chỉnh tư thế cùng HLV.
Nhân sự: 14 chính thức — 1 quản lý kiêm bán hàng, 2 HLV Gym, 2 nhân viên bể bơi, 2 lễ tân, 3 bán hàng kiêm HLV Pilates, 1 tạp vụ, 2 bảo vệ, 1 giáo viên yoga người Ấn Độ. Bể bơi cao điểm 6-8 HLV, thấp điểm 2-3.
Yoga: giáo viên Ấn Độ, 4 ca/ngày, ca chiều 16h-17h đông nhất (tuổi 45-70). Zumba: giáo viên Ấn Độ, 2 ca/ngày, tuổi 30-50. Pilates triển khai từ 12/2024: lớp 1:1, nhóm 1:3, nhóm 1:7; 2 giáo viên chuyên môn tốt. Tiện ích khác: phòng xông hơi, tủ đồ. Có phòng tư vấn chăm sóc sức khỏe chủ động với chuyên gia. Quy mô phục vụ tối đa ~1.500 khách thường xuyên; hiện đạt ~450 (30% công suất).
Bối cảnh xã hội: Vĩnh Yên dân số 125.858 người, thu nhập bình quân ~6,758 triệu/người/tháng; nhóm 18-50 tuổi ước ~60.000 người. Sau sáp nhập tỉnh, nhiều sở ban ngành chuyển lên Việt Trì (cách ~30km) nên nhóm khách công chức giảm.

PHẦN 3 — MÔ HÌNH KINH DOANH (nội bộ)
Fami Fitness kết hợp dịch vụ truyền thống với sản phẩm dinh dưỡng của Công ty CP Tập đoàn Liên kết Việt Nam (Vinalink) — lĩnh vực chăm sóc sức khỏe & làm đẹp, doanh nghiệp "thuần Việt 100%". Sản phẩm dùng công nghệ Delta-Immune (vách tế bào lợi khuẩn) tăng miễn dịch + dinh dưỡng tế bào + thảo dược Việt chống oxy hóa. Sản phẩm tiêu biểu: Vhealth, TopAPro, Green Quantum, Genecel Max, Detoxmune Max, Lactocol Max… Fami có mã số kinh doanh hệ thống; nhân sự Fami xếp dưới tài khoản Fami, khách tham gia kinh doanh xếp dưới tài khoản nhân viên (tư vấn viên/HLV). Mục tiêu: mọi người phát triển thu nhập thụ động qua hệ thống, tăng chất lượng chăm sóc khách, thúc đẩy học tập, tạo môi trường đoàn kết, nhân bản mô hình ra các cơ sở khác.`,
  },
  {
    title: "Fami — Tác dụng & đối tượng từng bộ môn (tài liệu 2)",
    category: "fitness",
    text: `TÁC DỤNG & ĐỐI TƯỢNG PHÙ HỢP CỦA TỪNG BỘ MÔN

1. BƠI LỘI (phễu thu hút mềm, khởi động chuyển hóa): bể bơi 4 mùa DUY NHẤT Vĩnh Yên (bể người lớn 400m2, bể trẻ em 70m2, khu học bơi 330m2), tập quanh năm. Vận động dưới nước giảm tải hoàn toàn áp lực lên hệ xương khớp; đốt calo cực kỳ hiệu quả nhưng không gây mệt mỏi quá sức. Đối tượng: người béo phì lâu năm, mỡ nội tạng cao, đau mỏi xương khớp do gánh nặng trọng lượng, tâm lý sợ phòng tạ nặng, sợ chấn thương; trẻ em và người muốn học bơi bài bản.

2. GIẢI CƠ SÂU / GIẢI CƠ THỂ THAO (phễu trải nghiệm, thư giãn tức thì): liệu pháp y học thể thao hỗ trợ phục hồi vận động cơ xương khớp; thư giãn tức thì ngay sau 1 buổi, thấy cơ thể nhẹ hơn hẳn; "gãi đúng chỗ ngứa" cho vùng cơ rệu rã, căng cứng, đau mỏi vai gáy. Đối tượng: khách thừa cân "nỗi đau kép" từng giảm cân sai cách; dân văn phòng/công chức ngồi nhiều ít vận động (lưu ý nhóm công chức đang giảm do sáp nhập tỉnh, dời trụ sở lên Việt Trì cách ~30km).

3. GYM (hệ sinh thái phá vỡ ách tắc & kích hoạt): máy móc hiện đại (máy chạy, giàn tập đa năng, máy tập ngực); 800m2 trong nhà + 300m2 sân ngoài có mái che. Tác dụng cốt lõi KHÔNG phải ép xác mà vận động để phá vỡ ách tắc cơ thể, kích hoạt lại trao đổi chất đang ngủ quên. Mồi câu tài chính: mua thẻ năm tặng 2 tháng tập nhóm nhỏ cùng HLV, hoặc ưu đãi PT 1:1. Đối tượng: khách đã được thu hút qua bơi/giải cơ, cần HLV cá nhân theo sát để đổi tư duy "tập để giảm cân" sang "vận động để thông mạch, ăn đúng để giảm mỡ"; thanh niên/người dân 18-50 tuổi (~60.000 người) muốn phát triển cơ bắp, rèn thể lực.

4. YOGA (cân bằng thể chất & tinh thần): phòng 300m2, sức chứa 40-60 hội viên, đủ dụng cụ (vòng, bóng, gạch, dây) và hệ thống dây tập yoga bay; giáo viên người Ấn Độ trực tiếp đứng lớp. Điều hòa nhịp thở, phục hồi thể trạng suy nhược, giảm căng thẳng, hỗ trợ người mất ngủ, trào ngược dạ dày; tăng dẻo dai. Đối tượng: nhóm lớn tuổi (45-70, ca chiều 16h-17h), phụ nữ 28-35 (ca sáng), nhóm dưới 40 tuổi (ca trưa) muốn dẻo dai và giảm căng thẳng.

5. PILATES (tái thiết cấu trúc & trị liệu chuyên sâu): máy chuyên nghiệp Reformer tower, Cadillac, Wunda Chair, Ladder Barrel; tập 1:1 với HLV hoặc lớp nhóm nhỏ 1:3, 1:7; HLV chuyên môn tốt, đang đào tạo chuẩn quốc tế. Điều chỉnh lại cấu trúc tư thế cơ thể do mang gánh nặng trọng lượng béo phì lâu năm, làm khoẻ cơ lõi. Đối tượng: người cần chỉnh tư thế, người muốn phương pháp tập hiện đại an toàn, sẵn sàng chi trả gói PT 1:1.

Định hướng chung: bản chất là kinh doanh "chuyển đổi toàn diện" chứ không cho thuê thiết bị. Sau khi mời khách tới bằng các dịch vụ mềm, dựa trên chỉ số InBody, chuyên viên tư vấn chuyên sâu về hệ vi sinh đường ruột, enzyme và kết hợp hệ sinh thái dinh dưỡng tế bào Vinalink để cân bằng chuyển hóa, giảm mỡ bền, chống tái béo.`,
  },
  {
    title: "Fami — Bảng giá, khuyến mãi & gói giảm cân (tài liệu 3)",
    category: "chung",
    text: `BẢNG GIÁ DỊCH VỤ VÀ CÁC KHUYẾN MÃI (đơn vị: nghìn đồng)

I. NGUYÊN TẮC ĐƯA KHUYẾN MÃI: mục tiêu để dễ bán hơn và có cơ hội bán thêm dịch vụ khách chưa trải nghiệm. Đưa khuyến mãi phù hợp nhu cầu (có sẵn hoặc nhu cầu ẩn). Nên tặng khuyến mãi là dịch vụ KHÁC dịch vụ chính khách đang dùng (tặng trải nghiệm giải cơ, buổi tư vấn dinh dưỡng chuyên sâu) để có cơ hội bán thêm và hiểu khách hơn. Đưa khuyến mãi TỪ TỪ, không đưa hết ngay từ đầu; dùng khuyến mãi làm công cụ chốt sale; đánh vào tâm lý sợ bỏ lỡ để khách quyết sớm với gói theo năm.

II. DỊCH VỤ & KHUYẾN MÃI

1. GYM: GYM 1T = 500 (tặng 3 vé bơi hoặc 1 buổi giải cơ sâu); GYM 3T = 1450 (tặng tới 10 vé bơi hoặc 2 buổi giải cơ sâu); GYM 6T = 2550 (tặng 3 buổi giải cơ sâu + 1h tư vấn dinh dưỡng); GYM 12T = 4500 (tặng 1 tháng tập nhóm cùng HLV + 3h tư vấn dinh dưỡng + 3 buổi giải cơ sâu).

2. YOGA: YOGA 1T = 650 (tặng 3 vé bơi hoặc 1 buổi giải cơ sâu); YOGA 3T = 1850 (tặng tới 10 vé bơi hoặc 2 buổi giải cơ sâu); YOGA 6T = 3350 (tặng 3 buổi giải cơ sâu + 1h tư vấn dinh dưỡng); YOGA 12T = 5800 (tặng 1 tháng tập nhóm cùng HLV + 3h tư vấn dinh dưỡng).

3. BƠI NGƯỜI LỚN: BƠI NL 1T = 700 (tặng 3 vé bơi hoặc 1 buổi giải cơ sâu); BƠI NL 3T = 1800 (tặng 2 buổi giải cơ sâu); BƠI NL 6T = 2500 (tặng 3 buổi giải cơ sâu + 1h tư vấn dinh dưỡng); BƠI NL 12T = 4500 (tặng 3 buổi giải cơ sâu).

4. BƠI TRẺ EM (quà tặng dành cho bố mẹ bé): BƠI TE 1T = 600 (tặng 3 vé bơi hoặc 1 buổi giải cơ sâu bố mẹ); BƠI TE 3T = 1500 (tặng 2 buổi giải cơ sâu cho bố mẹ); BƠI TE 6T = 2000 (tặng 3 buổi giải cơ sâu + 1h tư vấn dinh dưỡng cho bố mẹ); BƠI TE 12T = 3600 (tặng 3 buổi giải cơ sâu cho bố mẹ).

5. DẠY HỌC BƠI: HỌC BƠI LỚP = 1500 (tặng thêm 2 tháng bơi); HỌC BƠI 1-1 = 3000 (tặng thêm 2 tháng bơi, có thể tặng thêm 1 buổi giải cơ sâu nếu là người lớn).

6. FULL — tập TẤT CẢ dịch vụ tại Fami: FULL 1T = 800 (tặng 1 buổi giải cơ sâu); FULL 3T = 2280 (tặng 2 buổi giải cơ sâu); FULL 6T = 4080 (tặng 3 buổi giải cơ sâu + 1h tư vấn dinh dưỡng); FULL 12T = 7200 (tặng 2 tháng tập nhóm cùng HLV + 3h tư vấn dinh dưỡng + 3 buổi giải cơ sâu).

7. GÓI 2 DỊCH VỤ (Gym+Bơi, Yoga+Bơi, Gym+Yoga — 3 loại giá bằng nhau, khuyến mãi tương đương nhưng linh hoạt; đặt tên theo quy tắc "Dịch vụ 1 Dịch vụ 2 Thời gian", ví dụ GYM BOI 3T): 1 tháng = 700 (tặng 1 buổi giải cơ sâu); 3 tháng = 1995 (tặng 2 buổi giải cơ sâu); 6 tháng = 3570 (tặng 3 buổi giải cơ sâu + 3h tư vấn dinh dưỡng); 12 tháng = 6300 (tặng 2 tháng tập nhóm cùng HLV + 3h tư vấn dinh dưỡng + 3 buổi giải cơ sâu).

8. GÓI GIẢI PHÁP GIẢM CÂN (cam kết giảm 6kg-10kg khi làm đúng hướng dẫn): Giảm cân 1 = 3900 (thực hành bơi giảm cân 3 tháng; dạy bơi 1 kiểu; tặng 1 sản phẩm VHealth; tư vấn dinh dưỡng 3 buổi; có tư vấn kèm cặp dinh dưỡng hằng ngày). Giảm cân 2 = 5400 (thực hành bơi giảm cân 6 tháng; dạy bơi 1 kiểu; tặng 1 sản phẩm VHealth; tư vấn dinh dưỡng 3 buổi; kèm cặp hằng ngày). Giảm cân 3 = 6300 (tập Gym và bơi giảm cân 12 tháng; tặng 2 tháng tập cùng HLV Gym lớp nhóm; tư vấn dinh dưỡng 3 buổi; kèm cặp hằng ngày). Giảm cân 4 = giá theo nhu cầu (khách muốn giảm từ 20kg trở lên sẽ có hỗ trợ riêng từ trung tâm Fami Fitness).`,
  },
];

async function main() {
  const existing = await listDocs();
  const removeTitles = new Set([...OLD_TITLES, ...DOCS.map((d) => d.title)]);
  for (const old of existing.filter((e) => removeTitles.has(e.title))) {
    await deleteDoc(old.id);
    console.log(`  (xoá bản cũ #${old.id} "${old.title}")`);
  }
  for (const d of DOCS) {
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
