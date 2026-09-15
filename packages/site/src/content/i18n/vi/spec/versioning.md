---
source: '954281dd7ebde528ca176407d310556ec7749057'
---

# Đánh phiên bản

Ba thành phần được đánh phiên bản độc lập: bản đặc tả, các schema và mọi công cụ hiện thực bản đặc tả.

## Bản đặc tả

1. Bản đặc tả mang một phiên bản SemVer (hiện tại là **1.0.0**). Thay đổi phá vỡ tương thích đòi hỏi một phiên bản major; mọi thay đổi đều được ghi vào changelog của kho mã nguồn.
2. Một lớp ngữ cảnh khai báo nhánh đặc tả mà nó nhắm tới trong `leji.json` qua khoá tự đặt tên `leji` (ví dụ `"leji": "1.0"`), theo quy ước của OpenAPI. Giá trị này là **nhánh** đặc tả (`major.minor`), không bao giờ là phiên bản patch: một bản patch (từ `1.0.0` lên `1.0.1`) tinh chỉnh câu chữ hoặc công cụ mà không dịch chuyển nhánh, nên manifest vẫn giữ `"1.0"` qua mọi bản patch. Công cụ **MUST** kiểm tra một lớp ngữ cảnh theo đúng nhánh được khai báo, chứ không theo nhánh mới nhất.

## Nhánh preview

Một nhánh đặc tả **MAY** được chỉ định là **preview**. Nhánh preview có thể sửa đổi tại chỗ: nó **MAY** thay đổi theo những cách vốn sẽ là phá vỡ tương thích, thay vì phải nâng lên một phiên bản mới, cho tới khi được đóng băng ở thời điểm phát hành chính thức (GA). Quy tắc "thay đổi phá vỡ tương thích đòi hỏi một phiên bản major" (mục 1) và quy tắc "`$id` dịch chuyển khi hình thái thay đổi không tương thích" (mục 3) chỉ có hiệu lực từ lúc đóng băng ở GA trở đi, chứ không áp dụng khi nhánh còn ở preview. Tại GA, nhánh được đóng băng và cả hai quy tắc bắt đầu có hiệu lực.

Một nhánh phát hành trước khi có bản chính thức **MUST** khai báo điều đó ngay ở lần phát hành đầu tiên.

Nhánh 1.0 **đã đóng băng ở bản phát hành công cụ tham chiếu v1.3.0**. Trong nhánh này, thay đổi schema chỉ được phép là thêm mới và `$id` vẫn ở `v1.0`; mọi thay đổi không tương thích đều phát hành thành một nhánh mới, không bao giờ sửa tại chỗ.

## Các schema

3. Mỗi schema mang một `$id` ổn định theo dạng `https://leji.org/schemas/v<major>.<minor>/<name>.schema.json`. Dòng `$id` chỉ dịch chuyển khi hình thái của schema thay đổi không tương thích.
4. Trong một nhánh đã phát hành, thay đổi schema **MUST** chỉ là thêm mới (thêm trường tuỳ chọn). Việc bỏ trường hoặc đổi ngữ nghĩa đòi hỏi một nhánh mới.
5. Các artifact máy đọc được khác ngoài manifest khai báo nhánh schema mà chúng được viết theo, qua `schemaVersion`; manifest khai báo nhánh đặc tả mà nó nhắm tới qua khoá tự đặt tên `leji` (mục 2).

## Tập ổn định

Những thứ sau được đóng băng trong một nhánh đặc tả; công cụ (kể cả các bản hiện thực thương mại sau này) xây dựng dựa trên chúng mà không cần một schema song song:

- hình thái của manifest và tên tệp cố định `leji.json`,
- các định danh danh mục (`domain`, `system`, `practice`, `governance`, `decisions`),
- các định danh mức tuân thủ (`core`, `indexed`, `governed`, `federated`),
- các quy tắc chuẩn hoá định danh và đường dẫn theo [machine-readable-surface.md](/vi/spec/machine-readable-surface/),
- hình thái của mục index, mục changelog, agent profile và bản ghi quyết định.

## Công cụ hiện thực (tham khảo)

Các SDK và CLI dùng phiên bản SemVer riêng, đồng thời khai báo những nhánh đặc tả mà chúng hỗ trợ. Các SDK tham chiếu trong kho mã nguồn này gồm gói npm `@leji-org/leji` (packages/sdk), gói PyPI `leji` (packages/sdk-py) và Go module `leji` (packages/sdk-go, một binary tĩnh duy nhất); chúng có hành vi giống hệt nhau và được kiểm tra bằng cùng một bộ fixture dùng chung.
