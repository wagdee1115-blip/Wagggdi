# مركبات V11 — Production Hardening

هذه النسخة تعالج أهم فجوات V11: مصادقة جلسة آمنة، API فعلية، قفل ذري للمركبة، Workflow نقل الملكية، RBAC موسع، فحص قاعدة البيانات، وتهيئة اختبارات.

## تشغيل محلي
1. انسخ `.env.example` إلى `.env`.
2. ضع `DATABASE_URL` و `JWT_SECRET`.
3. `npm install`
4. `npm run db:generate`
5. `npm run db:push` أو `npm run db:migrate`
6. `npm run db:seed`
7. `npm run typecheck`
8. `npm test`
9. `npm run build`

## قبل الإنتاج
- استبدال Mock Identity/Phone/Payment/Bank/Government بمزودين رسميين مصرح بهم.
- تخزين المستندات في private object storage مع signed URLs قصيرة العمر.
- إضافة WAF/rate limiting/central logging/monitoring/secrets manager.
- تشغيل migrations عبر CI/CD وليس `db:push` في الإنتاج.
- مراجعة قانونية وتنظيمية لأي خدمة مرور أو دفع أو تحقق هوية.
- لا تعتبر بيانات Mock إثباتًا حكوميًا أو بنكيًا.

## API الأساسية
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET/POST /api/vehicles`
- `POST /api/transfers`
- `GET/PATCH /api/transfers/:id`
- `GET /api/health`
