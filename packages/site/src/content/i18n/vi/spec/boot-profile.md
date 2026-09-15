---
source: '1262b1582c84a85bd21e37942936012c3a4048b4'
---

# Boot profile

**Boot profile** là điểm vào không phụ thuộc agent của lớp ngữ cảnh: một tài liệu duy nhất, người đọc được, để mọi agent host và mọi người cùng bắt đầu. Tài liệu này trả lời ba câu hỏi: "lớp ngữ cảnh này là gì, tôi phải nạp những gì, và tôi phải hành xử thế nào ở đây?".

## Yêu cầu

1. Lớp ngữ cảnh **MUST** có đúng một boot profile, nằm ở đường dẫn mà `bootProfilePath` trong manifest khai báo. Mặc định **RECOMMENDED** là `docs/boot-profile.md`.
2. Boot profile **MUST** là markdown thuần, một người không cần công cụ gì cũng đọc được. Nó **MUST NOT** phụ thuộc vào cú pháp cấu hình của bất kỳ nhà cung cấp nào.
3. Boot profile **MUST** bao gồm:
   - **Danh tính**: một đoạn văn cho biết kho mã nguồn hay sản phẩm này là gì.
   - **Nạp**: cần đọc ngữ cảnh nào cho loại tác vụ nào. Phần này **MUST** đưa ra một tập vô điều kiện (đọc gì trước mọi tác vụ), rồi tới các bộ chọn theo loại tác vụ, định tuyến theo đường dẫn, theo danh mục, hoặc qua context index, cùng một phương án dự phòng đã định nghĩa cho tác vụ không khớp bộ chọn nào. Diễn đạt bằng ngôn ngữ tác vụ, đây chính là cách thuật toán Định tuyến tác vụ ([machine-readable-surface.md](/vi/spec/machine-readable-surface/)) thể hiện ở tầng boot profile; đi theo nó không đòi hỏi phải biết gì về thuật toán đó.
   - **Tư thế**: những kỳ vọng vận hành đặt lên agent (khi nào cứ làm, khi nào phải hỏi, việc gì không bao giờ được làm). Phần này **MAY** được mang theo bằng cách dẫn chiếu tới nội dung governance hoặc tới một agent profile cốt lõi.
4. Boot profile **SHOULD** liên kết tới manifest, tới index (nếu có), và tới các agent profile (nếu có), để một agent bước vào qua bất kỳ host nào cũng khám phá được toàn bộ bề mặt máy đọc được.
5. Boot profile **MUST** nói bằng ngôn ngữ tác vụ: nó nêu tên các đường dẫn cụ thể và một thứ tự nạp rõ ràng, và đi theo nó không đòi hỏi phải biết gì về bản đặc tả này. Manifest và schema tồn tại cho công cụ, không phải cho agent; một boot profile đòi người đọc phải rành đặc tả mới theo được là một dấu hiệu xấu về mức tuân thủ.
6. Boot profile **SHOULD** nêu rõ các nghĩa vụ bảo trì của lớp ngữ cảnh: thay đổi của nó được ghi ở đâu (changelog đã khai báo) và quyết định được ghi lại ra sao (vị trí bản ghi quyết định đã khai báo). Bộ kiểm tra sẽ cảnh báo khi boot profile không nhắc tới cái nào trong hai thứ đó.
7. Các tệp điểm vào của nhà cung cấp chuyển hướng tới boot profile theo quy tắc vendor adapter trong [context-layer.md](/vi/spec/context-layer/).
8. Tập nạp vô điều kiện của boot profile (những gì nó bảo phải đọc trước mọi tác vụ) **SHOULD** được giới hạn trong đúng phần mà mọi tác vụ đều cần. Ngữ cảnh mà chỉ một số tác vụ cần **SHOULD** được định tuyến theo tác vụ, theo danh mục, hoặc qua index, thay vì nạp sẵn; và bản ghi quyết định **SHOULD** được định tuyến theo `affectedPaths` / `affectedCategories` mà chúng khai báo, thay vì nạp cả thư mục, vì chúng tích tụ vô hạn. Mọi thứ trong tập vô điều kiện đều bị trả giá ở mọi tác vụ.
9. **Các lớp ngang hàng trong federation.** Một lớp ngữ cảnh có khai báo `federation.mounts` (theo [distribution.md](/vi/spec/distribution/)) **MUST** làm nổi lên những lớp ngang hàng đó trong boot profile dưới một dạng máy kiểm được: một hoặc nhiều khối rào có chuỗi thông tin là `leji-mounts`, đặt ở bất cứ đâu trong tài liệu, các mục của chúng nối lại theo thứ tự trong tài liệu và mang đúng một mục cho mỗi mount đã khai báo. Một mục nêu tên lớp ngang hàng, chủ sở hữu của nó, nó chứa gì, và khi nào cần đọc nó, hai điều sau viết bằng ngôn ngữ tác vụ của chính người soạn. Ví dụ đầy đủ nằm bên dưới phần yêu cầu.

   Văn phạm được cố định để mọi bản hiện thực đọc giống hệt nhau. Một khối **mở** bằng một dòng có từ ba dấu backtick trở lên, theo sau là chuỗi thông tin, và **đóng** bằng dòng kế tiếp có từ ba dấu backtick trở lên; số backtick của rào đóng không nhất thiết khớp với rào mở. Chuỗi thông tin chỉ gồm `leji-mounts`; một rào mang thêm token nào sau đó là một lỗi, không bao giờ là một rào bị bỏ qua. Các dòng rào **MAY** mang phần thụt đầu dòng và phần đệm bằng dấu cách hoặc tab, còn các bản ghi nằm giữa chúng thì **MUST NOT**: một bản ghi bắt đầu ở cột 1 với `- mount: `, và các trường của nó thụt vào đúng hai dấu cách ASCII. Trong một bản ghi, `owner`, `carries` và `read-when` mỗi trường xuất hiện đúng một lần, theo thứ tự bất kỳ; trường lạ, trường trùng lặp và trường thiếu đều là lỗi. Một giá trị là phần còn lại không rỗng của dòng sau tiền tố `key: `, không có dấu cách hay tab ở đầu và cuối, và không chứa ký tự điều khiển hay ký tự phân tách dòng. Khoảng trắng trong văn phạm này là dấu cách ASCII (U+0020) và tab (U+0009), không gì khác, trong phần thụt và phần đệm của dòng rào cũng như trong một dòng nội dung; các bản hiện thực **MUST NOT** dùng lớp khoảng trắng của runtime ở đây, vì chúng bất đồng về những ký tự như U+0085 và U+00A0 và sẽ bất đồng về chuyện một khối có tồn tại hay không. Một byte order mark UTF-8 ở đầu tệp được cắt bỏ trước khi phân tích. Các dòng được tách theo LF, chấp nhận có CR ở cuối, dòng trống và dòng bắt đầu bằng `#` chiếm trọn dòng đều được bỏ qua (như trong các khối index danh mục ở [content-categories.md](/vi/spec/content-categories/)), và tệp là UTF-8. Việc quét dựa trên từng dòng và không xét tới cấu trúc markdown: một dòng mang từ ba backtick trở lên cùng với tag, sau phần thụt đầu dòng tuỳ chọn bằng dấu cách hay tab, sẽ mở một khối thật ở bất cứ chỗ nào nó nằm trong tài liệu, kể cả bên trong một ví dụ rào dài hơn hay bên trong một mục danh sách. Do đó, một ví dụ chỉ để minh hoạ chứ không để khai báo phải được rào bằng một **tag khác**, không bao giờ bằng cách thêm một token sau `leji-mounts`: tag mới là thứ bộ quét đối sánh, nên `leji-mounts example` sẽ mở một khối thật và báo lỗi phân tích cú pháp, còn một rào gắn tag `text` thì không mở gì cả. `mount` **MUST** khớp với `name` của một mount đã khai báo và `owner` **MUST** khớp với `owner.name` đã khai báo của mount đó, so sánh dưới dạng chuỗi đã giải mã; một mục cho một mount chưa khai báo, một mục thứ hai cho cùng một mount, và một mount đã khai báo mà không có mục nào, tất cả đều là lỗi. Một lớp ngữ cảnh không khai báo mount nào **MUST NOT** mang khối `leji-mounts`.

   Vị trí của lớp ngang hàng cố ý không phải một thành phần trong đó: một mount được hiện thực hoá trong một phép chiếu cục bộ trên máy, định địa chỉ theo nội dung, nên người đọc giải nó bằng `leji mounts locate <name>` chứ không suy ra một đường dẫn (theo [distribution.md](/vi/spec/distribution/)). Văn xuôi quanh khối **SHOULD** giải thích cách định tuyến một cách tự nhiên; khối là phần lõi kiểm được, không bao giờ thay thế cho phần văn xuôi ấy hay cho phần khai báo trong `leji.json`. Các lớp ngang hàng đã mount là những nguồn riêng biệt, có tên, không bao giờ bị trộn vào các danh mục của lớp chủ; boot profile chỉ định tuyến agent vào một lớp ngang hàng khi tác vụ khớp với cách định tuyến của nó hoặc khi profile yêu cầu. Phần không được kiểm là cố ý: `carries` và `read-when` là văn bản tự do, và mức độ trung thực của chúng với siêu dữ liệu định tuyến của mount là do nhóm tự khai chứ không do công cụ xác minh, vì công cụ chỉ kiểm việc liệt kê, danh tính và sự hiện diện. Việc làm nổi các lớp ngang hàng ở đây giữ cho việc khám phá mount nằm ngay trong điểm vào bằng ngôn ngữ tác vụ của agent, nên đi theo yêu cầu 5 vẫn không cần đọc manifest.

### Một khối `leji-mounts` đầy đủ

Một mục, cho một lớp chủ khai báo đúng một mount tên `acme-product-context`. Khối nằm ở cột 1 trong boot profile, đúng như nó hiện ra ở đây; rào bốn backtick bên ngoài là lớp bọc của chính tài liệu này và không thuộc về khối.

````markdown
```leji-mounts
- mount: acme-product-context
  owner: Product team
  carries: product-side domain language and the decisions behind the customer-facing surface
  read-when: a task touches product behavior, product terminology, or billing
```
````

## Agent profile

Một lớp ngữ cảnh **MAY** định nghĩa các profile theo vai trò (ví dụ profile người xem xét, profile phát hành, profile QA) nằm dưới một thư mục do `machine.agentProfilesPath` khai báo. Mỗi profile:

1. **MUST** là markdown kèm frontmatter YAML hợp lệ theo [`agent-profile.schema.json`](/vi/schemas/agent-profile/).
2. **MUST**, sau khi đã giải xong phần kế thừa, mang theo những gì vai trò đó đọc trước tiên (`requiredRead`) và khi nào nó phải dừng lại để hỏi (`mustAskWhen`). Một profile có khai báo `inherits` **MAY** bỏ qua một trong hai nếu profile gốc đã cung cấp; một profile không khai báo `inherits` thì **MUST** tự khai báo cả hai.
3. **MAY** khai báo `inherits`, và trường này có hiệu lực trong nhánh 1.0: nó nêu tên đúng một profile khác trong tập profile của lớp ngữ cảnh, profile đó **MUST** có `role` là `core`, và profile hiện tại mở rộng tư thế lẫn phần thân của nó. Tập profile của lớp ngữ cảnh gồm mọi tài liệu nằm dưới `machine.agentProfilesPath` đã khai báo, cùng mọi tài liệu được nêu tên trong map `agents` của manifest, bất kể tài liệu đó nằm ở đâu. Việc giải chỉ đi một tầng, nên một profile có `role` là `core` **MUST NOT** khai báo `inherits`, và đích được nêu tên **MUST** tồn tại, **MUST** là duy nhất theo `id`, và bản thân nó **MUST NOT** khai báo `inherits`. Việc giải kết hợp như sau:
   - **Các mảng tư thế** (`requiredRead`, `defaultContext`, `mustAskWhen`, `mustRefuseWhen`): các mục của profile gốc theo đúng thứ tự đã soạn, rồi tới các mục của profile dẫn xuất theo thứ tự của nó, bỏ đi những mục mà profile gốc đã có. Thứ tự soạn chính là chủ ý về việc nạp, nên không có gì bị sắp xếp lại.
   - **Mọi trường còn lại** (`id`, `name`, `role`, `purpose`, `version`, `host`, `invocation`, `escalation`, `owners`, `freshness`): lấy của chính profile dẫn xuất, không bao giờ kế thừa. `inherits` là một chỉ thị về việc giải và bản thân nó không thuộc về profile đã giải xong.
   - **Phần thân**: cả hai phần thân đều là chuẩn tắc, phần của profile gốc trước, rồi tới phần của profile dẫn xuất.

   Một bên tiêu thụ không giải được một profile có kế thừa thì **MUST NOT** tự mình áp dụng tệp dẫn xuất; tệp dẫn xuất chỉ là một nửa của một profile, nên bên tiêu thụ báo là không hỗ trợ thay vì áp dụng. Ở nơi một điều kiện phải hỏi và một điều kiện phải từ chối cùng áp cho một tình huống, thì từ chối thắng.

   Việc giải bảo đảm sự kết hợp, chứ không bảo đảm sự thu hẹp ngữ nghĩa: văn xuôi ở profile dẫn xuất mà mâu thuẫn hoặc nới lỏng profile gốc là không tuân thủ, và không công cụ nào phát hiện được một mâu thuẫn trong ngôn ngữ tự nhiên.

Profile điều chỉnh _một vai trò nạp gì và hành xử ra sao_; chúng không nhân bản nội dung của lớp ngữ cảnh.

Hai trường tuỳ chọn `host` và `invocation` của một profile là dạng viết tắt cho trường hợp một actor: chúng nói cách triệu tập bên tham gia duy nhất lấp vai trò này. `command` của nó là một khuôn theo đúng quy tắc của khuôn lệnh dành cho actor, kể cả chỗ giữ `<prompt>` và cách đặt nó (xem [context-layer.md](/vi/spec/context-layer/), phần Yêu cầu). Ở nơi một vai trò có nhiều hơn một bên tham gia đủ điều kiện, hoặc nơi cùng một bên tham gia cần cách triệu tập khác nhau tuỳ vai trò đang lấp, thì registry `actors` tuỳ chọn của manifest mang việc đó thay (cùng mục ấy). Một vai trò dùng cơ chế này hoặc cơ chế kia, không bao giờ dùng cả hai.

## Ghi chú (tham khảo)

Boot profile được chủ ý viết thật đơn giản: đó là tấm bản đồ kèm tư thế làm việc, không phải kho tri thức. Nếu boot profile dài quá vài màn hình, tức là có nội dung đang nằm ở điểm vào trong khi lẽ ra phải thuộc về một danh mục.

Thiết kế này ngăn một kiểu hỏng do quá nhiều tầng gián tiếp: mỗi bước chuyển từ ngữ cảnh đầu tiên của agent đến ràng buộc thực sự đều tiêu tốn thêm sự chú ý. Một lớp ngữ cảnh được thiết kế tốt không cần điểm vào nào của nhà cung cấp (lệnh triệu tập có thể trỏ thẳng tới boot profile), còn boot profile dẫn thẳng tới nội dung. Chiều sâu nên nằm trong các tài liệu của lớp ngữ cảnh, không phải trên con đường dẫn tới chúng.

Mọi tài liệu mà boot profile yêu cầu đọc trước tất cả tác vụ đều tạo chi phí cho từng tác vụ, nên tập vô điều kiện là phần đắt đỏ nhất của lớp ngữ cảnh. Chỉ giữ ở đó những gì thực sự dùng chung; phần còn lại nên được định tuyến theo loại tác vụ, danh mục, index và phạm vi tự khai báo của từng bản ghi quyết định. Index giúp agent nạp đúng lát cắt cần cho tác vụ thay vì cả cây; quyết định thì tích luỹ không giới hạn, nên phải được định tuyến chứ không bao giờ nạp sẵn cả thư mục.
