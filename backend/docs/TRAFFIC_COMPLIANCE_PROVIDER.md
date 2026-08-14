# عقد مزود المخالفات وتجديد التسجيل

تستخدم هذه الرحلة مزودًا حقيقيًا واحدًا عبر `TRAFFIC_PROVIDER_URL` و`TRAFFIC_PROVIDER_SECRET`. إذا لم يُضبطا، تعيد الواجهات `503` ولا تنشئ بيانات أو نجاحات تجريبية. يجب أن يكون الرابط HTTPS في الإنتاج، وألا يحتوي اسم مستخدم أو كلمة مرور ضمن الرابط.

كل الطلبات هي `POST` إلى العنوان المهيأ، بمهلة 12 ثانية، ومنع التحويلات، والترويسات التالية:

```http
Authorization: Bearer <secret>
Idempotency-Key: <server-derived-key>
Content-Type: application/json
```

يرسل الخادم `action` ومفتاح idempotency نفسه داخل JSON. لا يجب أن يعرض المزود المفتاح السري أو يضعه في رابط دفع أو مرجع عملية.

لا تُفتح رحلتا المخالفات أو التجديد ولا يُنشر إعلان عام إلا لسجل مركبة حالته `VERIFIED`. يتطلب التجديد كذلك مركبة نشطة وغير محجوزة وبلا قيد قانوني. بعد خروج السجل من `UNKNOWN` تُقفل اللوحة ورقم الهيكل ولا يتغيران إلا عبر الدعم وإعادة التحقق.

كل طلب يرسل `vehicle={id,plateNumber,vin}`. يجب أن يعيد كل رد `subject={vehicleId,plateNumber,vin}` مطابقًا حرفيًا؛ ويضيف رد الدفع `subject.violationReference`. رفض أي اختلاف إلزامي لمنع إسناد رد مركبة إلى أخرى.

## توثيق ملكية المركبة وتفعيلها

- يحفظ `POST /api/vehicles` المركبة `DRAFT/UNKNOWN` فقط ولا يدعي ملكية حكومية.
- يستدعي `POST /api/vehicles/:id/verify-ownership` الإجراء `VERIFY_VEHICLE_OWNERSHIP` بعد تحقق هوية المستخدم الوطنية.
- الطلب يرسل `vehicle={id,plateNumber,vin}` و`owner={userId,nationalId}` بمفتاح idempotency مشتق خادميًا من الـsubject كاملًا.
- يجب أن يعيد المزود عقدًا صارمًا: `decision` يساوي `VERIFIED` أو `REJECTED`، و`providerReference` غير فارغ، و`subject={vehicleId,plateNumber,vin,userId,nationalId}` مطابقًا حرفيًا.
- لا تصبح المركبة `ACTIVE/VERIFIED` إلا بعد قرار `VERIFIED` مطابق داخل transaction يعيد قفل المركبة والمستخدم ويتحقق من عدم تغير أي جزء من الـsubject. القرار المرفوض أو فشل الشبكة يبقيها مسودة وغير موثقة.
- لا يعاد `nationalId` أو `providerReference` إلى الواجهة، ولا يخزن الرقم الوطني في `Operation.metadata`; يخزن digest فقط مع حالة القرار اللازمة لإعادة التشغيل والمصالحة.

## المخالفات

- `INQUIRE_VEHICLE_VIOLATIONS`: يعيد `status: "CONFIRMED"` و`snapshotComplete: true` و`snapshotSequence` عددًا صحيحًا رتيبًا وغير سالب لكل subject، والـ`subject` الثلاثي المطابق، ثم مصفوفة لا تتجاوز 200 مخالفة. لكل مخالفة: `reference`, `type`, `summary`, `amountYER`, `issuedAt`, `dueAt`, `status`.
- `START_VIOLATION_PAYMENT`: يعيد الـ`subject` الثلاثي و`subject.violationReference` مطابقين، وحالة من `PAYMENT_REQUIRED`, `PENDING`, `PAID`, `FAILED`. يتطلب `PAID` مرجع مزود ومبلغًا مطابقًا. رابط الدفع مطلوب فقط مع `PAYMENT_REQUIRED` ويجب أن يكون HTTPS في الإنتاج.

لا يُعرض `reference` أو مرجع المزود للعميل. لا تُسجل المخالفة مدفوعة إلا بعد رد `PAID` مطابق أو لقطة لاحقة مؤكدة من المزود.

## تجديد التسجيل

- `CHECK_REGISTRATION_RENEWAL_ELIGIBILITY`: يعيد `status: "CONFIRMED"` والـ`subject` الثلاثي المطابق و`eligible`, `feesYER`, `currentExpiryDate`. عند الأهلية يجب إرجاع `cycleId` و`eligibilityReference`؛ لا يُعرضان ولا يُخزنان.
- `SUBMIT_REGISTRATION_RENEWAL`: يعيد حالة من `PAYMENT_REQUIRED`, `PENDING_GOVERNMENT`, `COMPLETED`, `REJECTED`, `FAILED` مع المركبة المطابقة و`providerSequence` عددًا صحيحًا رتيبًا وغير سالب ضمن مرجع المزود. تتطلب الحالات المقبولة مرجع مزود، وتتطلب `PAYMENT_REQUIRED` رابط دفع HTTPS في الإنتاج، ويتطلب `COMPLETED` تاريخ انتهاء جديدًا.
- `GET_REGISTRATION_RENEWAL_STATUS`: يعيد العقد نفسه ويربط الرد بمرجع المزود السابق ويزيد `providerSequence` عند كل تغير للحالة. تكرار sequence نفسه يجب أن يعيد النتيجة المنطقية نفسها؛ اختلاف المحتوى لنفس sequence يُرفض.

يُحفظ في `Operation` فقط الحد الأدنى اللازم للمطابقة والاستئناف: المركبة، الحالة، الرسوم، sequence المزود، digest النتيجة، وتاريخ الانتهاء المؤكد. تحفظ رحلة المخالفات آخر `snapshotSequence` وdigest اللقطة تحت مفتاح state ثابت للمركبة. اللقطة الأقدم لا تُطبق، وتكرار sequence بمحتوى مختلف يفشل مغلقًا. لا تُحفظ رموز الأهلية أو روابط الدفع أو أسرار المصادقة؛ يعاد رابط الدفع مؤقتًا في الرد الحي فقط.

مفاتيح الإرسال والدفع ثابتة لكل محاولة لمنع التكرار. تُعاد حالة `PENDING` بمفتاح المحاولة نفسه، وينشئ `FAILED` المؤكد محاولة جديدة بسجل ومفتاح مستقلين، بينما يبقى `MANUAL_REVIEW` مغلقًا للمصالحة. أما مفاتيح الاستعلام عن المخالفات والأهلية وحالة التجديد فتتغير كل دقيقة حتى لا يحبس مزود idempotency لقطة قديمة إلى الأبد.

`snapshotSequence` و`providerSequence` جزء إلزامي من العقد؛ أي مزود قديم لا يعيدهما سيُرفض بـ`TRAFFIC_PROVIDER_RESPONSE_INVALID` بدل تطبيق حالة غير مرتبة.
