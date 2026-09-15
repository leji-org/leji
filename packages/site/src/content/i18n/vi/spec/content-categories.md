---
source: 'a3eeaf11354342889990125636ea6bac78512d34'
---

# Danh mục nội dung

Leji định nghĩa năm danh mục nội dung theo **logic**. Các danh mục phân loại tài liệu theo _mục đích sử dụng_, không theo nơi lưu trữ: tên danh mục là những định danh ổn định dùng chung cho manifest, index và công cụ. Còn tên thư mục do nhóm tự quyết định.

## Năm danh mục

| Danh mục | Những gì thuộc về nó |
|---|---|
| `domain` | Ngôn ngữ nghiệp vụ và ngữ nghĩa sản phẩm, bằng chính lời của nhóm: những danh từ cốt lõi nghĩa là gì, chúng liên hệ với nhau ra sao, những thuật ngữ có nghĩa riêng ở đây. Bản ghi về trạng thái nghiệp vụ (tình trạng một hợp đồng, một lát cắt thị trường) cũng thuộc về đây, dưới dạng bản ghi. |
| `system` | Kiến trúc và các bất biến của nó: ranh giới dịch vụ, quyền sở hữu dữ liệu, hợp đồng tích hợp, mô hình nhất quán, hợp đồng khi lỗi, những ràng buộc mà mọi thay đổi đều phải sống chung. Các đánh giá kỹ thuật và báo cáo hệ thống thuộc về đây, dưới dạng bản ghi. |
| `practice` | Những quy ước và khuôn mẫu được áp dụng một cách tự động: quy ước viết code, khuôn mẫu kiểm thử, cùng những khuôn mẫu về prompt và quy trình đã được chứng minh (xem cổng đúc kết bên dưới). Bản ghi về việc áp dụng một phương pháp (một buổi retro, nhật ký chạy một runbook) thuộc về đây, dưới dạng bản ghi. |
| `governance` | Các ràng buộc bảo vệ cho agent và các quy tắc vận hành: agent được làm gì mà không cần hỏi, việc gì cần một cổng chặn có người, quy tắc xử lý dữ liệu, điều kiện leo thang, các kiểm soát tuân thủ. Bằng chứng quản trị (nhật ký kiểm toán, một báo cáo xem xét) thuộc về đây, dưới dạng bản ghi. |
| `decisions` | Bản ghi có ngày tháng về lý do mọi thứ lại như hiện nay, theo [decisions.md](/vi/spec/decisions/). |

## Chủ ý và bản ghi

Mọi tài liệu được quản trị đều hoặc là **chủ ý** hoặc là một **bản ghi**, độc lập với danh mục của nó:

- **Chủ ý** là sự thật ở hiện tại được duy trì: bảng thuật ngữ, bất biến, quy ước, ràng buộc bảo vệ. Người đọc dựa vào nó như thứ còn hiệu lực, nên khi thực tế đổi thay, tài liệu được sửa lại. Chủ ý chính là thứ mà hạn xem xét lại và cơ chế độ tươi sinh ra để phục vụ (xem [governance.md](/vi/spec/governance/)).
- Một **bản ghi** giữ lại các khẳng định trong một ranh giới thời gian hoặc sự kiện được nêu rõ: trạng thái, đánh giá, sổ ghi, báo cáo, kết quả cuộc họp, lưu trữ. Trạng thái về sau **thay thế** một bản ghi chứ không sửa nó; bản gốc vẫn là một tường thuật đúng về thời điểm của nó. Bề mặt thể hiện tính cập nhật của một bản ghi là **ngày tháng** của nó, không bao giờ là một hạn xem xét lại.

Để phân loại, hãy trả lời một câu hỏi: _nếu thông tin sau này mâu thuẫn với tài liệu, ta phải sửa tài liệu vì người đọc coi nó là thông tin hiện hành, hay thông tin mới sẽ thay thế nó còn bản gốc vẫn là ghi chép đúng về thời điểm trước đó?_ Nếu phải sửa, đó là chủ ý; nếu bị thay thế, đó là bản ghi.

Một bản ghi được quản trị y hệt như chủ ý: được lập index, được xem xét, có chủ sở hữu, và được định tuyến. Khác biệt nằm ở chỗ người đọc được phép làm gì với nó: người đọc **MUST NOT** coi một bản ghi là chủ ý hiện hành; nó là bằng chứng có ngày tháng (xem [context-layer.md](/vi/spec/context-layer/), phần Đọc một bản ghi). Bản ghi quyết định là dạng bản ghi chính thức: tự thân chúng là bản ghi, với schema và vòng đời riêng theo [decisions.md](/vi/spec/decisions/).

Một số câu hỏi về bản ghi cố ý nằm ngoài 1.0 và được thừa nhận thay vì giấu đi: không có khái niệm máy hiểu được về một _chuỗi_ bản ghi (nên công cụ không bao giờ chứng nhận bản ghi nào là "mới nhất"), không có cơ chế theo dõi độ mới của một dòng bản ghi (liệu bản ghi kế tiếp đã quá hạn chưa), và không có phân loại ở mức từng mục cho những tài liệu trộn lẫn đáng kể cả chủ ý lẫn nội dung bản ghi. Một tài liệu trộn lẫn **SHOULD** được tách ra; ở nơi việc tách là quá tốn kém, hãy phân loại theo hợp đồng mà người đọc phía sau chủ yếu dựa vào. Nội dung thành thật mà nói là không hợp danh mục nào thì cứ để làm tài liệu tham khảo; việc phân loại không hứa hẹn là sẽ khỏi cần phán đoán.

## Yêu cầu

1. Manifest **MUST** ánh xạ mỗi danh mục mà nó tuyên bố tới một hoặc nhiều **tệp index** có đường dẫn tương đối từ gốc kho mã nguồn (`categories.<id>.indexes`); mỗi tệp index **SHOULD** nằm dưới gốc ngữ cảnh đã khai báo, theo [context-layer.md](/vi/spec/context-layer/). Một tệp index khai báo việc đưa vào, chứ không di dời: nội dung vẫn nằm ở nơi nhóm vốn để nó (ví dụ `business/`, `technology/`, `architecture/`), và một thư mục có thể đóng góp tài liệu cho nhiều danh mục mà không phải đổi tên gì cả.
2. Một tệp index là markdown được biên tập có mang một hoặc nhiều khối mã rào `leji-index`. Một khối **mở** bằng một dòng có từ ba dấu backtick trở lên, theo sau là chuỗi thông tin của khối, và **đóng** bằng dòng kế tiếp có từ ba dấu backtick trở lên; số backtick của rào đóng không nhất thiết khớp với rào mở. Chỉ đúng ba chuỗi thông tin là hợp lệ: `leji-index` (một khối chủ ý), `leji-index intent` (cũng thế, nói rõ ra), và `leji-index record` (một khối bản ghi, các mục trong đó được giải thành bản ghi). Bất kỳ token nào khác sau `leji-index` đều là lỗi phân tích cú pháp, không bao giờ bị âm thầm bỏ qua: văn phạm này hữu hạn theo thiết kế. Mỗi khối liệt kê nội dung mỗi dòng một mục theo dạng `- path: <đường-dẫn-tương-đối-từ-gốc-kho-mã>`, trong đó một đường dẫn là một thư mục (markdown bên trong được đưa vào theo cách đệ quy) hoặc một tệp markdown đơn lẻ. Một đường dẫn **MUST** là POSIX tương đối từ gốc kho mã nguồn: một dấu `/` mở đầu, một đoạn `..`, hay một dấu gạch chéo ngược đều không hợp lệ và bị từ chối. Dòng trống và dòng chú thích `#` chiếm trọn dòng đều được bỏ qua, và một mục **MAY** mang một `# chú thích` ở cuối dòng, phía trước có khoảng trắng. Khoảng trắng trong văn phạm này là dấu cách ASCII (U+0020) và tab (U+0009), không gì khác, ở mọi nơi văn phạm cần tới nó: quanh các backtick của rào và chuỗi thông tin, làm phần đệm đầu và cuối của một dòng mục, và ngay trước dấu `#` mở một chú thích cuối dòng. Một byte order mark UTF-8 ở đầu tệp được cắt bỏ trước khi phân tích. Các dòng được tách theo LF, chấp nhận có CR ở cuối, và tệp là UTF-8. Các bản hiện thực **MUST NOT** dùng lớp khoảng trắng của runtime ở đây: mọi ký tự khác mà một runtime tình cờ xếp vào loại khoảng trắng, trong đó có U+0085 và U+00A0, đều là nội dung đường dẫn bình thường, nên một mục có đường dẫn chứa ký tự như vậy sẽ bị báo là không tìm thấy chứ không bị âm thầm cắt bỏ. Các khối `leji-mounts` của [boot-profile.md](/vi/spec/boot-profile/) được đóng băng trên cùng bảng chữ cái đó, nên một bộ quét đọc được cả hai văn phạm và ba bản hiện thực không thể bất đồng về chuyện một rào có tồn tại hay không. Nhiều khối trong cùng một tệp được nối lại theo thứ tự trong tài liệu. Văn xuôi và tiêu đề quanh các khối đều được phép, nên một tệp index kiêm luôn vai trò một tấm bản đồ người đọc được của danh mục. Việc quét dựa trên từng dòng và không xét tới cấu trúc markdown: một dòng mang từ ba backtick trở lên cùng với tag, sau phần thụt đầu dòng tuỳ chọn bằng dấu cách hay tab, sẽ mở một khối thật ở bất cứ chỗ nào nó nằm trong tài liệu, kể cả bên trong một ví dụ rào dài hơn hay bên trong một mục danh sách. Do đó, một ví dụ chỉ để minh hoạ chứ không để khai báo phải được rào bằng một **tag khác**, không bao giờ bằng cách thêm một token sau `leji-index`: tag mới là thứ bộ quét đối sánh, nên `leji-index example` sẽ mở một khối thật và báo lỗi phân tích cú pháp, còn một rào gắn tag `text` thì không mở gì cả. Vị trí **RECOMMENDED** là `context/<id>.md` dưới gốc ngữ cảnh; vị trí này cấu hình được và công cụ không bao giờ ghi cứng nó.
3. Một lớp ngữ cảnh **MUST** ánh xạ ít nhất `domain` hoặc `system`, cộng thêm `decisions`, để tuyên bố được bất kỳ mức tuân thủ nào (xem [conformance.md](/vi/spec/conformance/)), và phần tối thiểu `domain`/`system` có nội dung **MUST** gồm ít nhất một tài liệu **chủ ý**: một lớp ngữ cảnh chỉ toàn bản ghi thì giữ được lịch sử nhưng không mang theo ngữ cảnh vận hành nào. Các danh mục còn lại bồi đắp dần khi nhóm gặp câu hỏi thật; một danh mục rỗng (danh mục mà tệp index của nó không giải ra tài liệu nào) **MUST NOT** được ánh xạ chỉ để cho đủ một danh sách kiểm.
4. Một tài liệu được giải về đúng một danh mục và một loại. Các mục index là **bộ chọn**, và việc giải tuân theo **độ đặc hiệu của bộ chọn**: một bộ chọn trỏ thẳng vào tệp thắng mọi bộ chọn thư mục, và một bộ chọn thư mục sâu hơn thắng một bộ chọn thư mục tổ tiên. Bộ chọn đặc hiệu nhất bao phủ một tài liệu sẽ quyết định danh mục và loại khối của tài liệu đó; một tài liệu mà một bộ chọn rộng hơn có bao phủ nhưng một bộ chọn đặc hiệu hơn thắng thì đơn giản là không thuộc nội dung của bộ chọn rộng kia (đó là cách diễn đạt một tệp luôn được cập nhật nằm trong một thư mục bản ghi, hay nhật ký quyết định của một nhóm nằm trong một cây đã ánh xạ rộng hơn, mà không phải di chuyển gì cả). Những bộ chọn **ngang** độ đặc hiệu mà bất đồng về danh mục hoặc loại là một lỗi, không bao giờ được giải theo thứ tự index; những gán ngang độ đặc hiệu mà giống hệt nhau thì chỉ giải một lần, còn một mục bị lặp y nguyên trong cùng một tệp index thì bị từ chối. Công cụ **SHOULD** làm nổi lên bộ chọn nào mà mọi tài liệu nó bao phủ đều bị các bộ chọn đặc hiệu hơn giành mất (một bộ chọn _bị che_): đó là phần thừa trong tấm bản đồ được biên tập, không bao giờ là một lỗi. Ngoài ra, việc giải là tất định: một mục thư mục nở ra thành các tệp markdown của nó theo thứ tự từ điển POSIX (theo Unicode code point; **RECOMMENDED** giữ đường dẫn ở ASCII để thứ tự không mơ hồ giữa các bản hiện thực), và mọi đường dẫn có vị trí thật (sau khi giải symlink) thoát ra ngoài **gốc kho mã nguồn** đều bị loại trừ chứ không đi theo. Các mục index (xem [machine-readable-surface.md](/vi/spec/machine-readable-surface/)) mang theo định danh danh mục và loại.
5. Một tài liệu **MAY** khai báo loại của mình trong frontmatter (`kind: intent` hoặc `kind: record`); frontmatter ghi đè loại khối của bộ chọn thắng cuộc và **không bao giờ** ghi đè danh mục. Mọi giá trị `kind` khác đều là lỗi. Bản ghi quyết định không nhận khoá `kind` (schema của chúng là đóng và tự thân chúng đã là bản ghi). Một bản ghi **MAY** mang một `date` trong frontmatter (`YYYY-MM-DD`); công cụ đọc ngày của một bản ghi **chỉ** từ trường đó, không bao giờ từ văn xuôi, quy ước tiêu đề hay tên tệp. Một bản ghi **MUST NOT** mang `freshness.reviewAfter` (hạn xem xét lại là một cơ chế của chủ ý; đặt trên một bản ghi, nó hứa hẹn một tính cập nhật mà tài liệu không thể có, và đó là một lỗi).
6. Nội dung practice mô tả các khuôn mẫu prompt hay quy trình **SHOULD** chỉ được đúc kết sau khi khuôn mẫu đó đã hiệu quả ít nhất hai lần (cổng chứng minh qua hai lần). Đúc kết quá sớm chính là cách các thư mục practice đầy lên bằng nguyện vọng.

## Ghi chú (tham khảo)

Không phải danh mục nào cũng cần có ngay từ ngày đầu. Lớp ngữ cảnh tối thiểu khả dụng chỉ gồm những gì công việc trong tháng đầu thực sự cần đến. Nhờ các danh mục, người hoặc agent có thể hỏi "đây là loại sự thật nào?" rồi nạp đúng lát cắt cần cho tác vụ trước mắt, thay vì nạp cả cây.

Hai loại này tồn tại vì tài liệu của một kho mã nguồn thật vốn là hai kho ngữ liệu đan xen với hai mô hình sự thật khác nhau, và ép nửa vận hành phải theo ngữ nghĩa của chủ ý thì hỏng cả hai đường: hoặc là những lời hứa về độ tươi không thể giữ, hoặc là phần lớn kho mã nguồn bị đẩy ra ngoài vòng quản trị. Một hình hài đã dùng thật, với một ngoại lệ chủ ý nằm bên trong một thư mục bản ghi:

````markdown
# Ngữ cảnh lĩnh vực

```leji-index
- path: docs/glossary.md
```

Trạng thái vận hành được quản trị như bản ghi; chính sách leo thang vẫn là chủ ý.

```leji-index record
- path: docs/operations/
```

```leji-index intent
- path: docs/operations/escalation-policy.md
```
````
