---
source: '4075c6eda5df10f30c81842b2f6e2ebb82d2fd78'
---

# Mức tuân thủ

Việc áp dụng theo từng phần là chủ ý thiết kế. Có bốn mức, mỗi mức sau bao hàm mức trước; nhóm tuyên bố mức của mình trong manifest (`conformance.claimedLevel`). Mọi tuyên bố đều là tự khai: không có chương trình chứng nhận nào.

Mức tuân thủ được đánh giá trên **lớp ngữ cảnh đúng như nó hiện ra ở nơi phép kiểm chạy**, chứ không phải trên một lớp chính thống nào đó mà một bản sao có thể đang đại diện. Một bản sao tới được mà không kèm kho mã nguồn của nó thì được đọc ở chế độ suy giảm theo [context-layer.md](/vi/spec/context-layer/), và đọc ở chế độ suy giảm không bao giờ là con đường dẫn tới thẩm quyền chính thống: một bản sao như vậy không xác minh được, và công cụ sẽ nói thẳng ra điều đó chứ không để câu hỏi lửng lơ.

Phần lớn các mục trong danh sách kiểm đều **máy xác minh được**: công cụ tham chiếu kiểm tra chúng trên lớp ngữ cảnh và bác bỏ tuyên bố không đáp ứng yêu cầu. Có bốn kết quả báo cáo, và chúng được chủ ý quy định là không thể dùng thay cho nhau:

- **`fail`**: bằng chứng đã được thu thập và yêu cầu không được đáp ứng.
- **(khai theo quy trình)**, báo cáo là **`manual`**: mục này mô tả một thực hành của nhóm (một cổng xem xét, một job CI, một bên tiêu thụ bên ngoài) mà không công cụ nào xác nhận được nếu chỉ nhìn vào kho mã nguồn, nên nhóm tự đứng ra bảo đảm. Chỉ những mục được gắn nhãn **(khai theo quy trình)** bên dưới mới bao giờ được báo cáo theo cách này.
- **`unknown`**: một mục máy kiểm mà bằng chứng không lấy được trong lần chạy này, chẳng hạn phép kiểm khả năng với tới pin trong federation khi không có quyền truy cập nguồn, hoặc kỷ luật chỉ thêm mới khi không có mốc git nào để so sánh. `unknown` không bao giờ trao một mức, và cũng không bao giờ bác bỏ một tuyên bố mà một lần chạy có bằng chứng có thể xác nhận được.
- **`not applicable`**: một mục máy kiểm có điều kiện nhưng không áp cho lớp ngữ cảnh này, chẳng hạn các mục về mount trong federation trên một lớp không khai báo mount nào. Nó không được chấm điểm, và cũng không phải bằng chứng theo chiều nào cả.

`verifiedLevel` mà công cụ báo cáo là mức cao nhất mà mọi mục **máy xác minh được** có áp dụng đều đạt, và **không bao giờ cao hơn mức mà lớp ngữ cảnh tuyên bố**; cả `fail` lẫn `unknown` đều chặn việc trao mức, còn những mục khai theo quy trình hoặc không áp dụng thì không được chấm. Việc chặn trần theo tuyên bố là có chủ ý: việc xác minh trả lời câu hỏi tuyên bố có đứng vững hay không, chứ không phải lớp ngữ cảnh này lẽ ra có thể tuyên bố tới đâu, nên một lớp tuyên bố `core` mà bằng chứng đủ đưa nó lên `governed` thì vẫn được báo là `core`, và cách để nâng mức được báo cáo là nâng chính tuyên bố. `verifiedLevel` không bao giờ khẳng định thay cho các mục khai theo quy trình, nên một `verifiedLevel` đạt là điều kiện cần chứ chưa đủ cho một mức có mang những mục đó. Mọi mục bên dưới đều là máy xác minh được, trừ khi được gắn nhãn **(khai theo quy trình)**.

Hai mục máy xác minh được hành xử khác đi trên một bản sao suy giảm, và khác biệt đó là hệ quả của việc mỗi mục có bằng chứng gì. **Sự hiện diện của git** thì có câu trả lời: một bản sao không nằm trong một kho git thì không đáp ứng yêu cầu ở mức `core` rằng lớp ngữ cảnh phải nằm trong một kho mã nguồn như vậy, nên mục đó là `fail`. **Kỷ luật chỉ thêm mới của changelog** thì không có câu trả lời: tệp có thể hoàn toàn đúng khuôn dạng trong khi trạng thái đã commit trước đó, thứ cần để đối chiếu, lại không với tới được, nên mục đó là `unknown` và lớp ngữ cảnh đơn giản là không xác minh được ở mức `indexed` từ bản sao ấy. Cả hai mục này đều không được báo là `manual`, vì nhãn đó dành riêng cho các mục đã gắn nhãn khai theo quy trình. Ngoài ra, quy tắc về độ tươi dành cho người đọc (làm nổi ngữ cảnh lỗi thời đã nạp, và dừng lại hoặc hỏi khi một mục **bắt buộc** đã hết hạn, theo [governance.md](/vi/spec/governance/)) là quy tắc về hành vi của người đọc, không phải một cổng chặn mức tuân thủ: lệnh `leji route` tham chiếu đóng dấu lên mỗi tài liệu đã định tuyến hạn xem xét lại và thời điểm hết hạn của nó, để một agent áp dụng được quy tắc ấy.

Có ba mục hôm nay được xác minh ở độ sâu thấp hơn chủ ý đã nêu của chúng, và khoảng cách đó được nói thẳng ở đây thay vì để người đọc tự phát hiện. Mục về boot profile được xác minh ở mức sự hiện diện tại đường dẫn đã khai báo và ở mức có các tiêu đề danh tính, phần nạp và tư thế (mọi lần chạy `validate` đều báo một tiêu đề còn thiếu dưới dạng cảnh báo `boot-profile-sections`, chứ không phải cổng chặn), còn việc phần danh tính có nói được điều gì thực chất hay không thì đi nhờ phép lint `--content` tuỳ chọn, thứ cũng chỉ ra nội dung mẫu còn sót ở bất kỳ chỗ nào trong profile. Mục về quyết định thật được xác minh ở mức frontmatter hợp lệ theo schema trên ít nhất một bản ghi giải được; phần nội dung thực chất của thân bài (một quyết định thật, không phải một khung rỗng) cũng đi nhờ `--content`. Mục về changelog là mục thứ ba: kỷ luật chỉ thêm mới được kiểm so với trạng thái của tệp ở `HEAD`, tức là bắt được một lần viết lại còn nằm trong cây làm việc, đúng trường hợp mà một hook pre-commit sinh ra để phục vụ. Trong một bản checkout của hệ tích hợp liên tục thì cây làm việc **chính là** `HEAD`, nên một lần viết lại đã commit sẵn thì phép kiểm không nhìn thấy, và việc xem xét bộ thay đổi mới là thứ phủ được chỗ đó. Do vậy mục này xác minh cây làm việc, chứ không xác minh lịch sử. Chủ ý đã nêu trong cả ba mục vẫn mang tính chuẩn tắc về những gì một lớp ngữ cảnh tuân thủ phải có; việc đào sâu các phép kiểm bằng máy, và việc đối chiếu changelog với một phiên bản gốc tường minh, đều nằm trong lộ trình của công cụ tham chiếu. Việc xác minh mức `federated` còn đòi hỏi thêm ít nhất một mục `federation.mounts` được khai báo: một lớp ngữ cảnh chỉ đóng vai nhà cung cấp (được các kho mã nguồn khác tiêu thụ nhưng không tự khai báo mount nào) thì xác minh được ở `governed`, và tư cách federation của nó dựa trên các mục về tiêu thụ được khai theo quy trình.

## Mức 1: `core`

Một lớp ngữ cảnh tồn tại, và cả người lẫn agent đều làm việc được từ nó.

- [ ] Lớp ngữ cảnh nằm trong một kho git, được đánh phiên bản cùng với phần công việc mà nó mô tả (theo [context-layer.md](/vi/spec/context-layer/), phần Yêu cầu).
- [ ] Có `leji.json` ở gốc kho mã nguồn, hợp lệ theo schema của manifest.
- [ ] Có một boot profile ở đường dẫn đã khai báo, bao gồm danh tính, phần nạp và tư thế.
- [ ] Ít nhất `domain` hoặc `system` được ánh xạ (qua tệp index của nó) và có nội dung, với ít nhất một tài liệu **chủ ý** giải được (chỉ toàn bản ghi thì không mang theo ngữ cảnh vận hành nào), cộng thêm `decisions` với ít nhất một bản ghi quyết định **thật**: một bản ghi mang `status` cụ thể và một quyết định thật trong phần thân, không phải một khung rỗng hay nội dung mẫu.
- [ ] Có một chủ sở hữu chính được nêu tên.
- [ ] Các tệp điểm vào của nhà cung cấp, nếu có, đều chuyển hướng tới boot profile.

## Mức 2: `indexed`

Lớp ngữ cảnh đọc được đối với công cụ.

- [ ] Toàn bộ mức `core`.
- [ ] Có một context index được sinh ra, còn khớp với cây tệp.
- [ ] Có một changelog máy đọc được; các thay đổi của lớp ngữ cảnh đều ghi thêm mục vào đó.

## Mức 3: `governed`

Việc cưỡng chế nằm trong cơ chế vận hành, không dựa vào thiện chí.

- [ ] Toàn bộ mức `indexed`.
- [ ] Thay đổi của lớp ngữ cảnh đi qua cổng xem xét của kho mã nguồn; người phê duyệt. **(khai theo quy trình)**
- [ ] Có agent profile (ít nhất một profile có `role: core`) hợp lệ theo schema của profile.
- [ ] CI kiểm bề mặt này: manifest, index khớp với cây tệp, kỷ luật changelog, frontmatter của profile, và các đường dẫn đã khai báo đều giải được. **(khai theo quy trình)**
- [ ] Hạn tươi được khai báo và được kiểm (chỉ báo cáo cũng chấp nhận được).

## Mức 4: `federated`

Lớp ngữ cảnh trải rộng trên một tổ chức nhiều kho mã nguồn.

- [ ] Toàn bộ mức `governed`.
- [ ] Lớp ngữ cảnh được ít nhất một kho mã nguồn khác tiêu thụ dưới dạng một mount có ghim, và các lần cập nhật pin đến dưới dạng những bộ thay đổi xem xét được. **(khai theo quy trình)**
- [ ] Có sẵn cơ chế báo cáo pin lỗi thời: bên tiêu thụ thấy được pin của mình đang tụt lại bao xa so với ref đối chiếu. Báo cáo có nhận biết quan hệ tổ tiên của SDK tham chiếu phủ được các mount federation đã khai báo; phần báo cáo ở phía tiêu thụ ngoài đó ra là việc của nhóm. **(khai theo quy trình)**
- [ ] Mọi lớp ngữ cảnh ngang hàng đều được khai báo dưới dạng mount có ghim đầy đủ theo [distribution.md](/vi/spec/distribution/): một `source` đã chuẩn hoá và một `pin` là commit đầy đủ, với quyền sở hữu còn nguyên vẹn. Trạng thái hiện thực hoá trên một máy cụ thể nào đó không phải đầu vào của việc xét tuân thủ.
- [ ] Pin của mỗi mount đã khai báo đều với tới được từ một ref được quảng bá của `source` tương ứng (`trackingRef` đã khai báo, hoặc nhánh mặc định của nguồn). Phép kiểm này cần quyền truy cập nguồn: không có nó thì kết quả là `unknown`, và `unknown` không bao giờ trao mức. Một pin chỉ giải được nhờ một gợi ý cục bộ trên máy xác lập tính sẵn có, không phải mức tuân thủ.
- [ ] Mỗi mount đã khai báo đều mang siêu dữ liệu định tuyến: ít nhất `categories`, cộng thêm `topics` hoặc `requiredWhen`, để một agent quyết định được mức liên quan mà không phải đọc lớp ngang hàng.
- [ ] Boot profile làm nổi lên mọi lớp ngang hàng đã mount, và index được sinh ra mang mảng định tuyến `mounts`, để một agent khám phá và nạp được các lớp ngang hàng mà không phải đọc manifest (theo [boot-profile.md](/vi/spec/boot-profile/), [machine-readable-surface.md](/vi/spec/machine-readable-surface/)).

## Ghi chú (tham khảo)

`core` là mức tối thiểu khiến một lớp ngữ cảnh trở nên có thật, `indexed` thêm vào bề mặt được sinh ra mà công cụ đọc, `governed` là chỗ lớp ngữ cảnh thôi phụ thuộc vào kỷ luật của bất kỳ ai, còn `federated` dành cho những tổ chức nơi đã có hơn một nhóm sở hữu một lớp ngữ cảnh đáng giữ nguyên vẹn. Phần lớn các nhóm nên đi tới `governed` rồi dừng lại; `federated` tồn tại cho những tổ chức kia, chứ không phải như một huy hiệu trưởng thành.
