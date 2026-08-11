# مركبات V12 — Hardening & Integration Baseline

## ما تم إصلاحه
- توسعة Roles لتطابق RBAC الفعلي.
- إضافة `tsconfig.json` و`next-env.d.ts` و`.env.example`.
- منع fallback JWT secret في الإنتاج.
- إضافة session auth عبر HttpOnly cookie.
- Register/Login/Logout/Me APIs.
- Vehicles GET/POST APIs.
- Health check مع فحص PostgreSQL.
- Ownership Transfer API.
- Atomic vehicle lock لمنع البيع/النقل المزدوج.
- تثبيت سعر الصرف ورسوم النقل 80 USD لحظة إنشاء العملية.
- التحقق من أن البائع والمشتري Active وموثقان قبل إنشاء النقل.
- Sale status transition مع audit trail.
- OTP send/verify باستخدام hash، انتهاء، وعدد محاولات وحدّ معدل.
- إزالة bypass OTP الثابت `123456`.
- اختبارات Vitest أساسية لقواعد الرسوم والتحقق.
- تعليمات تشغيل وإطلاق Production.

## ما لا يمكن اعتباره 10/10 قبل توفر الاعتمادات الخارجية
- لا يوجد تكامل حكومي رسمي داخل الملف؛ Mock فقط.
- لا يوجد مزود دفع/بنك حقيقي؛ Mock فقط.
- لا يوجد مزود رسمي للتحقق من ملكية رقم الجوال/الهوية.
- تخزين المستندات يحتاج private object storage وsigned URLs.
- يلزم اختبار أمني خارجي قبل الإطلاق العام.

## معيار قبول الإطلاق
`typecheck + test + build + migration + integration tests + security review + official provider certification` يجب أن تمر كلها قبل تحويل النسخة إلى تطبيق إنتاجي.
