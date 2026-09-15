---
source: '9550ceea3130bc921e029e51d882c675dbcc3564'
---

# Quyết định

Bản ghi quyết định là phần ghi chép có ngày tháng của lớp ngữ cảnh về _lý do_: các quyết định kiến trúc, lựa chọn nhà cung cấp, ranh giới phạm vi và cả quyết định chủ ý không thực hiện một việc nào đó. Chúng giúp tránh tranh luận lại vấn đề cũ và cung cấp cho agent cả lập luận, thay vì chỉ một quy tắc đơn lẻ.

Bản ghi quyết định là dạng **record** chính thức (xem [content-categories.md](/vi/spec/content-categories/), phần Chủ ý và bản ghi): vốn dĩ đã là record, với schema và vòng đời thống nhất mà record thông thường không có. Mục index được sinh từ chúng mang `kind: record`; bản thân bản ghi quyết định không khai báo khoá `kind` (schema là đóng, nên nếu khai báo tường minh `kind`, bước kiểm tra sẽ thất bại).

## Yêu cầu

1. Bản ghi quyết định là markdown kèm frontmatter YAML hợp lệ theo [`decision-record.schema.json`](/vi/schemas/decision-record/), mỗi tệp một bản ghi. Kho quyết định là hợp của hai bề mặt được manifest khai báo, và một lớp ngữ cảnh **MAY** dùng một trong hai hoặc cả hai: đường dẫn bản ghi được khai báo (`machine.decisionRecordsPath`, mặc định `<root>/decisions/`) và những mục mà tệp index của danh mục `decisions` trỏ tới. Một bản ghi **MUST** tới được qua ít nhất một trong hai đường đó.
2. Frontmatter **MUST** mang: `id` (ổn định), `title`, `status`, và `date`. `status` là một trong `proposed`, `accepted`, `superseded`, `deprecated`, `rejected`.
3. Phần thân **MUST** nêu rõ, bằng văn xuôi: bối cảnh (tình huống nào buộc phải ra quyết định), bản thân quyết định, và các hệ quả của nó. Các tiêu đề mục **RECOMMENDED** là `## Context`, `## Decision`, `## Consequences`; một bản ghi **MAY** thêm `## Alternatives`.
4. Bản ghi là **lịch sử chỉ thêm mới**: một bản ghi **MUST NOT** bị sửa thành một quyết định khác. Hai trường frontmatter là **có thể thay đổi** khi quyết định già đi, là `status` (vòng đời của nó) và `supersededBy` (đặt khi nó bị thay thế); mọi thứ còn lại, gồm `id`, `title` và `date` gốc, phạm vi đã khai báo, và phần thân văn xuôi, là **bất biến** một khi đã công bố. Một sự đảo ngược hay thay đổi là một bản ghi mới, với frontmatter đặt `supersedes`, còn `status` của bản ghi cũ trở thành `superseded` kèm `supersededBy`. Liên kết thay thế **MUST** nhất quán theo cả hai chiều: khi bản ghi B đặt `supersedes: A`, bản ghi A mang `status: superseded` và có `supersededBy: B`, và một bản ghi `superseded` **MUST** nêu tên bản kế nhiệm của nó trong `supersededBy`. Cả hai bản ghi đều ở lại. Công cụ tham chiếu hôm nay đã cưỡng chế tính nhất quán hai chiều của liên kết thay thế. Nó chưa tự kiểm tra tính bất biến (rằng các trường đã đóng băng và phần thân của một bản ghi đã công bố không đổi so với một phiên bản gốc); đó là một phép kiểm tra dạng báo cáo còn nằm trong lộ trình, chưa phải một cổng chặn. Cho tới khi có nó, tính bất biến dựa vào kỷ luật xem xét được khai theo quy trình (xem [conformance.md](/vi/spec/conformance/)).
5. Một bản ghi **MAY** khai báo `affectedPaths` và `affectedCategories`, để công cụ định tuyến từ phạm vi của một tác vụ tới những quyết định chi phối nó. Cách phạm vi của một tác vụ chọn ra bản ghi (đối sánh đường dẫn có tính tới chồng lấn, khớp danh mục theo nghĩa hẹp, ràng buộc `accepted` / `deprecated`, và cách xử lý ở mức toàn tổ chức với một bản ghi không khai báo trường nào trong hai trường đó) là thuật toán Định tuyến tác vụ trong [machine-readable-surface.md](/vi/spec/machine-readable-surface/).
6. Đề xuất bị bác cũng là bản ghi (`status: rejected`). Một quyết định không làm, được viết ra, là cách rẻ nhất để khỏi phải bàn lại.

## Tương thích với ADR (tham khảo)

Bản ghi quyết định của Leji được thiết kế để tương thích với Architecture Decision Record: một thư mục ADR hiện có có thể đáp ứng `decisions` bằng cách thêm các trường frontmatter vào từng bản ghi (hoặc chỉ các bản ghi mới từ nay về sau), rồi ánh xạ thư mục trong manifest. Không bắt buộc phải dùng công cụ ADR nào, nhưng cũng không loại trừ công cụ nào.
