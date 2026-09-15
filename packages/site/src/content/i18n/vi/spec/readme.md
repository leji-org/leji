---
source: '8c1cff15b9d31409781d1bf0334bfd1cd9097101'
---

# Bản đặc tả Leji

**Leji là một bản đặc tả mở cho lớp ngữ cảnh dùng chung của các nhóm AI-native.** Nó định nghĩa cách một nhóm lưu trữ, quản trị, nạp và bảo trì phần ngữ cảnh thuộc về kho mã nguồn mà cả người lẫn AI agent đều đọc trong mọi tác vụ.

| | |
|---|---|
| **Phiên bản đặc tả** | 1.0.0 |
| **Trạng thái** | GA, đã đóng băng ở bản phát hành công cụ tham chiếu v1.3.0. Thay đổi phá vỡ tương thích đòi hỏi một phiên bản major mới. |
| **Chủ biên** | Vuong Nguyen |
| **Một trang** | [Toàn bộ bản đặc tả trên một trang duy nhất](https://leji.org/vi/spec/full/) |

## Nguyên tắc (tham khảo)

1. **Chủ ý thay vì chỉ dẫn.** Leji ghi lại chủ ý bền vững (mọi thứ nghĩa là gì, điều gì phải luôn đúng, vì sao lại như vậy), thay vì các chỉ dẫn mang tính mệnh lệnh gắn với từng nhà cung cấp. Người và agent tự suy ra hành động từ chủ ý đã khai báo và ngữ cảnh của tác vụ.
2. **Một vòng tròn, không phải một tầng.** Người với người, người với AI, và người với AI với người đều là những luồng hạng nhất quanh cùng một lớp ngữ cảnh. Bình đẳng về quyền đọc, không bình đẳng về quyền quyết: ai có quyền truy cập một lớp ngữ cảnh thì đọc được toàn bộ nó, ai cũng có thể đề xuất, và người là bên phê duyệt. Việc tham gia dựa trên vai trò chứ không dựa trên công cụ: một bên tham gia chưa từng trực tiếp động tới git vẫn là thành viên hạng nhất của vòng tròn. Bản thân quyền truy cập là việc của hệ quản lý phiên bản, không phải của Leji; vòng tròn được giới hạn trong nhóm đối tượng của một lớp ngữ cảnh.
3. **Cơ chế thay vì thiện chí.** Ngữ cảnh dùng chung mặc nhiên sẽ dần xuống cấp: thực tế thay đổi còn tài liệu thì không, và chẳng có gì buộc wiki phải luôn cập nhật. Việc cưỡng chế của Leji nằm trong cơ chế vận hành, không dựa vào thiện chí: mọi thay đổi đi qua cùng cổng xem xét như code, công cụ báo lỗi khi phát hiện trôi lệch máy kiểm được, hạn tươi làm lộ những gì đã cũ, và ngữ cảnh lỗi thời không bao giờ bị âm thầm coi là còn hiệu lực (về mặt chuẩn tắc, xem [governance.md](/vi/spec/governance/), phần Độ tươi).

Phần còn lại của bản đặc tả này là hệ quả chuẩn tắc của ba nguyên tắc trên.

## Ngôn ngữ tuân thủ

Các từ khoá **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY** và **OPTIONAL** trong bản đặc tả này được hiểu theo đúng mô tả trong [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Bản dịch này giữ nguyên các từ khoá tiếng Anh, vì chúng là thuật ngữ có định nghĩa chặt chẽ: **MUST** là bắt buộc, **MUST NOT** là cấm, **SHOULD** là nên, **SHOULD NOT** là không nên, **MAY** là tuỳ chọn.

## Cách trích dẫn bản đặc tả này (tham khảo)

Trích dẫn một mục theo tiêu đề của mục đó kèm phiên bản đặc tả, cùng một permalink tới neo của mục. Trên trang đặc tả, mỗi tiêu đề đều hiện neo của nó khi rê chuột lên.

- **Định dạng:** Leji 1.0, §_Tên mục_: `https://leji.org/spec/<document>/#<anchor>`
- **Ví dụ:** Leji 1.0, §The circle, normatively: `https://leji.org/spec/governance/#the-circle-normatively`

Hãy luôn trích dẫn kèm phiên bản (`Leji 1.0`): thay đổi phá vỡ tương thích sẽ ra mắt dưới dạng một phiên bản major mới, nên một trích dẫn có ghim phiên bản vẫn còn chính xác sau khi bản đặc tả tiến hoá. Trích dẫn trỏ tới trang tiếng Anh, vì đó mới là văn bản chuẩn tắc.

## Từ vựng

Những thuật ngữ sau được dùng nhất quán trong mọi tài liệu chuẩn tắc. Tên thuật ngữ giữ nguyên tiếng Anh, kèm cách gọi tiếng Việt tương ứng:

| Thuật ngữ | Nghĩa |
|---|---|
| **context layer** (lớp ngữ cảnh) | Chính là artifact mà bản đặc tả này chi phối: một tập tài liệu người đọc được và artifact máy đọc được, thuộc về kho mã nguồn, có đánh phiên bản, mã hoá phần ngữ cảnh vận hành bền vững của một nhóm. "Leji context layer" là dạng đầy đủ dùng khi cần phân biệt rõ. Luôn viết "context layer"; chữ "layer" đứng một mình chỉ dành cho việc gọi tên một thực thể đếm được trong federation (một lớp ngữ cảnh ngang hàng, chủ, đã mount, bị giới hạn, đồng hành, hoặc không truy cập được). |
| **agent** | Một hệ thống AI biết hành động: nó nạp ngữ cảnh của kho mã nguồn, thực hiện hoặc hỗ trợ công việc, và có thể đề xuất thay đổi. Đây là danh từ chuẩn tắc chỉ chủ thể hành động. |
| **person** / **people** (người) | Những người tham gia là con người. Người là bên nắm quyền phê duyệt. |
| **participant** (bên tham gia) | Một người hoặc một agent. |
| **audience** (nhóm đối tượng) | Những người và agent được quyền đọc một lớp ngữ cảnh, theo phân quyền của kho mã nguồn cùng mọi phân quyền hệ tệp hay ổ đĩa dùng chung để lộ bản checkout đó. Câu "ai cũng đọc được" chỉ áp dụng trong phạm vi nhóm đối tượng của một lớp ngữ cảnh; các nhóm đối tượng khác nhau được phục vụ bằng những lớp ngữ cảnh riêng, không bao giờ bằng cách chặn nội dung bên trong một lớp. |
| **agent host** | Sản phẩm hoặc runtime mà agent hoạt động thông qua đó (ví dụ Claude Code, Codex, Cursor). Vendor adapter là thứ cấu hình cho agent host. |
| **tool** (công cụ) | Một năng lực gọi được mà agent sử dụng (shell, tìm kiếm, một MCP server). Không bao giờ là tên một sản phẩm. |
| **vendor adapter** | Một tệp điểm vào của agent host, chỉ chuyển hướng tới boot profile và không bao giờ giữ nội dung chính thống. Một số tệp dùng chung được cho nhiều host (`AGENTS.md`); số khác chỉ phục vụ một host (`CLAUDE.md`, `.cursor/rules`). Quy tắc cho cả hai là như nhau; khác biệt chỉ nằm ở chỗ công cụ sinh ra gì theo mặc định. |
| **boot profile** | Điểm vào không phụ thuộc agent của lớp ngữ cảnh, dành cho cả người lẫn agent. |
| **agent profile** | Một tài liệu về cách nạp và tư thế làm việc theo từng vai trò, dành cho agent. |
| **AI** | Dùng như tính từ (AI-native) và trong tên các luồng **người với người**, **người với AI**, **người với AI với người**. Trong tên luồng, "AI" chỉ những agent hoạt động thông qua một agent host. |
| **model** (mô hình) | Cỗ máy dự đoán mà một agent chạy trên đó. Mô hình không đọc lớp ngữ cảnh; agent mới đọc. Từ này chỉ xuất hiện ở nơi cần phân biệt cỗ máy với chủ thể hành động (ví dụ việc chọn mô hình, vốn là một cơ chế riêng của từng host). |

Tóm gọn toàn bộ thứ bậc trong một dòng: **model** cung cấp năng lực cho **agent**; **agent** hoạt động qua **agent host** và gọi các **tool**; lớp ngữ cảnh giao tiếp với agent và host, không bao giờ trực tiếp với model. Bản đặc tả trung lập ở mọi tầng trong chồng này: bất kỳ model nào cung cấp năng lực cho bất kỳ agent nào, hoạt động qua bất kỳ host nào, cũng đều dùng cùng một lớp ngữ cảnh. "LLM" cố ý không nằm trong bộ từ vựng vì nó chỉ một lớp model cụ thể, còn bản đặc tả thì trung lập với model.

**Ranh giới phạm vi.** Leji 1.0 chi phối agent và những agent host nạp ngữ cảnh của kho mã nguồn. AI không mang tính agent (gợi ý tự động hoàn thành, gợi ý ngay trong dòng, trò chuyện không kèm ngữ cảnh kho mã nguồn) nằm ngoài phạm vi chuẩn tắc, trừ khi nó hoạt động như một phần của agent host có nạp lớp ngữ cảnh.

## Các tài liệu chuẩn tắc

Theo thứ tự đọc:

| Tài liệu | Định nghĩa |
|---|---|
| [context-layer.md](/vi/spec/context-layer/) | Lớp ngữ cảnh, manifest, gốc ngữ cảnh, quy tắc vendor adapter |
| [content-categories.md](/vi/spec/content-categories/) | Năm danh mục nội dung theo logic và cách tệp index ánh xạ nội dung vào chúng |
| [boot-profile.md](/vi/spec/boot-profile/) | Điểm vào không phụ thuộc agent mà mọi agent host đều nạp |
| [machine-readable-surface.md](/vi/spec/machine-readable-surface/) | Manifest, index, changelog, profile, bản ghi quyết định |
| [decisions.md](/vi/spec/decisions/) | Bản ghi quyết định |
| [governance.md](/vi/spec/governance/) | Đề xuất và phê duyệt, quyền sở hữu, việc đưa vào và loại bỏ, độ tươi |
| [distribution.md](/vi/spec/distribution/) | Monorepo, submodule nhiều kho mã nguồn, federation |
| [conformance.md](/vi/spec/conformance/) | Bốn mức tuân thủ và danh sách kiểm |
| [versioning.md](/vi/spec/versioning/) | Đánh phiên bản cho đặc tả và schema |

Các JSON Schema trong [`../schemas/`](/vi/schemas/) là chuẩn tắc đối với các artifact máy đọc được. Các tài liệu trong [`../rationale/`](/vi/rationale/) và [`../adoption/`](/vi/adoption/) không mang tính chuẩn tắc.

## Phạm vi của 1.0

**Trong phạm vi:** cung cấp ngữ cảnh, đặt ra ràng buộc, ghi lại quyết định, xem xét thay đổi, và đúc kết những khuôn mẫu dùng lại được; cách kết nối không phụ thuộc agent và các vendor adapter (ở mức nhẹ); ngữ nghĩa về quyền sở hữu và tính liên tục (ở mức nhẹ).

**Ranh giới mở rộng.** Leji 1.0 đặc tả lớp ngữ cảnh dùng chung chính thống: cách ngữ cảnh của một nhóm được viết, sở hữu, đánh phiên bản, đề xuất, phê duyệt, lập index và đọc. Nó cố ý **không** đặc tả những giao thức thực thi vận hành _xung quanh_ lớp ngữ cảnh đó: bao tác vụ, một giao thức bằng chứng tổng quát, việc bàn giao giữa agent với agent, giao thức phân quyền công cụ, và việc điều phối. Đó là những **giao thức mở rộng, không phải điều kiện tiên quyết**: một lớp ngữ cảnh tuân thủ 1.0 **MUST** vẫn hữu ích khi không có chúng, và một bản hiện thực **MUST NOT** đòi hỏi chúng để đọc, đề xuất, xem xét, phê duyệt hay kiểm tra lớp ngữ cảnh. Chúng sẽ hoàn thiện ngôn ngữ này khi thực tiễn sống chứng minh được, chứ không phải thứ được nghĩ ra một cách trừu tượng.

Leji **không** phải một ngôn ngữ lập trình, một DSL, một runtime, hay một dịch vụ SaaS. Nó là các quy ước markdown, vài JSON schema nhỏ, và ngữ nghĩa quản trị.
