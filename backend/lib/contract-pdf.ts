
// lib/contract-pdf.ts - عقد البيع PDF - مركبات
// قالب احترافي عام - ليس بديلا عن نموذج حكومي أو عقد قانوني معتمد

export interface ContractData {
  contractNumber: string;
  operationId: string;
  createdAt: Date;
  seller: {
    name: string;
    nationalId: string;
    phone: string;
    verificationStatus: string;
  };
  buyer: {
    name: string;
    nationalId: string;
    phone: string;
    verificationStatus: string;
  };
  vehicle: {
    plateNumber: string;
    vin?: string;
    make: string;
    model: string;
    year: number;
    color: string;
    mileage: number;
    imageUrl?: string;
  };
  financial: {
    vehicleAmountYER: number;
    platformFeeUSD: number;
    platformFeeYER: number;
    transferFeeUSD?: number;
    transferFeeYER?: number;
    listingCommissionUSD?: number;
    auctionFeeYER?: number;
    governmentFeesYER: number;
    totalPaidYER: number;
    sellerPayoutYER: number;
    exchangeRate: number;
    paymentMethod: string;
    paymentStatus: string;
  };
  transfer: {
    status: string;
    governmentReference?: string;
    transferDate: Date;
    electronicDocumentUrl?: string;
  };
  approvals: {
    buyerApprovedAt?: Date;
    buyerOtpVerifiedAt?: Date;
    sellerApprovedAt?: Date;
    sellerOtpVerifiedAt?: Date;
    paymentVerifiedAt?: Date;
  };
}

export class ContractPdfService {
  generateContractHtml(data: ContractData): string {
    return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8">
<title>عقد بيع مركبة - ${data.contractNumber}</title>
<style>
  * { font-family: Tahoma, Arial, sans-serif; }
  body { padding: 40px; color: #111; background: white; }
  .header { text-align: center; border-bottom: 3px solid #0f3d2e; padding-bottom: 20px; margin-bottom: 30px; }
  .logo { font-size: 28px; font-weight: 900; color: #0f3d2e; }
  .contract-number { font-size: 14px; color: #666; margin-top: 10px; }
  .alert { background: #fef3c7; border: 1px solid #f59e0b; padding: 12px; border-radius: 8px; font-size: 12px; margin-bottom: 20px; }
  .section { margin-bottom: 25px; }
  .section-title { font-weight: 900; font-size: 16px; color: #0f3d2e; border-bottom: 2px solid #0f3d2e; padding-bottom: 5px; margin-bottom: 15px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
  .field { }
  .label { font-size: 11px; color: #666; font-weight: 700; }
  .value { font-size: 13px; font-weight: 700; margin-top: 3px; }
  .table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  .table th, .table td { border: 1px solid #ddd; padding: 10px; text-align: right; font-size: 12px; }
  .table th { background: #0f3d2e; color: white; font-weight: 900; }
  .footer { margin-top: 40px; border-top: 2px solid #eee; padding-top: 20px; }
  .signature { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 40px; }
  .sig-box { border: 1px dashed #ccc; padding: 20px; text-align: center; border-radius: 8px; }
  .qr { text-align: center; margin-top: 20px; }
  .stamp { color: #0f3d2e; font-weight: 900; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">مركبات - منصة نقل ملكية المركبات</div>
    <div style="font-size: 12px; color: #666; margin-top: 5px;">MARKABAT - Vehicle Ownership Transfer Platform</div>
    <div class="contract-number">رقم العقد: ${data.contractNumber} | رقم العملية: ${data.operationId}</div>
    <div class="contract-number">تاريخ ووقت العقد: ${data.createdAt.toLocaleString('ar-YE')}</div>
  </div>

  <div class="alert">
    ⚠️ تنبيه: هذا القالب الحالي ليس بديلاً عن نموذج حكومي أو عقد قانوني معتمد إلى أن يتم اعتماده رسمياً من الجهات المختصة. 
    العقد يوثق الموافقات الإلكترونية والعملية المالية فقط. الاستمارة الإلكترونية الرسمية يتم الحصول عليها من نظام المرور الرسمي.
  </div>

  <div class="section">
    <div class="section-title">بيانات البائع</div>
    <div class="grid">
      <div class="field"><div class="label">الاسم الكامل</div><div class="value">${data.seller.name}</div></div>
      <div class="field"><div class="label">رقم الهوية</div><div class="value">${data.seller.nationalId}</div></div>
      <div class="field"><div class="label">رقم الجوال الموثق</div><div class="value">${data.seller.phone}</div></div>
      <div class="field"><div class="label">حالة التوثيق</div><div class="value">${data.seller.verificationStatus}</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">بيانات المشتري</div>
    <div class="grid">
      <div class="field"><div class="label">الاسم الكامل</div><div class="value">${data.buyer.name}</div></div>
      <div class="field"><div class="label">رقم الهوية</div><div class="value">${data.buyer.nationalId}</div></div>
      <div class="field"><div class="label">رقم الجوال الموثق</div><div class="value">${data.buyer.phone}</div></div>
      <div class="field"><div class="label">حالة التوثيق</div><div class="value">${data.buyer.verificationStatus}</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">بيانات المركبة</div>
    <div class="grid">
      <div class="field"><div class="label">رقم اللوحة</div><div class="value">${data.vehicle.plateNumber}</div></div>
      <div class="field"><div class="label">الماركة</div><div class="value">${data.vehicle.make}</div></div>
      <div class="field"><div class="label">الموديل</div><div class="value">${data.vehicle.model}</div></div>
      <div class="field"><div class="label">سنة الصنع</div><div class="value">${data.vehicle.year}</div></div>
      <div class="field"><div class="label">اللون</div><div class="value">${data.vehicle.color}</div></div>
      <div class="field"><div class="label">الممشى</div><div class="value">${data.vehicle.mileage.toLocaleString()} كم</div></div>
      ${data.vehicle.vin ? `<div class="field"><div class="label">رقم الهيكل (حسب الصلاحيات)</div><div class="value">${data.vehicle.vin}</div></div>` : ''}
    </div>
  </div>

  <div class="section">
    <div class="section-title">التفاصيل المالية</div>
    <table class="table">
      <tr><th>البند</th><th>المبلغ</th><th>ملاحظات</th></tr>
      <tr><td>قيمة المركبة</td><td>${data.financial.vehicleAmountYER.toLocaleString()} YER</td><td>يحددها البائع - بالريال اليمني</td></tr>
      <tr><td>عمولة المعرض/الخدمة</td><td>${data.financial.platformFeeYER.toLocaleString()} YER (${data.financial.platformFeeUSD} USD × ${data.financial.exchangeRate})</td><td>0 USD للسوق العادي؛ 100 USD فقط عند تطبيق خدمة المعرض</td></tr>
      <tr><td>رسوم النقل</td><td>${(data.financial.transferFeeYER ?? 0).toLocaleString()} YER (${data.financial.transferFeeUSD ?? 80} USD × ${data.financial.exchangeRate})</td><td>80 USD - مستقلة عن عمولة المعرض</td></tr>
      ${data.financial.auctionFeeYER ? `<tr><td>رسوم المزاد</td><td>${data.financial.auctionFeeYER.toLocaleString()} YER</td><td>2.5% من قيمة البيع النهائية</td></tr>` : ''}
      <tr><td>الرسوم الحكومية</td><td>${data.financial.governmentFeesYER.toLocaleString()} YER</td><td>حالياً 0</td></tr>
      <tr style="background: #f0fdf4; font-weight: 900;"><td>الإجمالي المدفوع من المشتري</td><td>${data.financial.totalPaidYER.toLocaleString()} YER</td><td>إلى حساب الوسيط</td></tr>
      <tr style="background: #fef3c7;"><td>المبلغ المحول للبائع</td><td>${data.financial.sellerPayoutYER.toLocaleString()} YER</td><td>قيمة المركبة فقط - بعد انتهاء فترة حماية الصرف</td></tr>
      <tr><td>طريقة الدفع</td><td>${data.financial.paymentMethod}</td><td>${data.financial.paymentStatus}</td></tr>
      <tr><td>سعر الصرف المثبت</td><td>1 USD = ${data.financial.exchangeRate} YER</td><td>مثبت وقت العملية - لا يتغير</td></tr>
    </table>
  </div>

  <div class="section">
    <div class="section-title">حالة نقل الملكية والموافقات</div>
    <table class="table">
      <tr><th>الحدث</th><th>التاريخ والوقت</th><th>الحالة</th></tr>
      <tr><td>موافقة المشتري</td><td>${data.approvals.buyerApprovedAt?.toLocaleString('ar-YE') || '-'}</td><td>${data.approvals.buyerApprovedAt ? '✅ تم' : '⏳'}</td></tr>
      <tr><td>OTP المشتري</td><td>${data.approvals.buyerOtpVerifiedAt?.toLocaleString('ar-YE') || '-'}</td><td>${data.approvals.buyerOtpVerifiedAt ? '✅ تم التحقق' : '⏳'}</td></tr>
      <tr><td>تأكيد الدفع</td><td>${data.approvals.paymentVerifiedAt?.toLocaleString('ar-YE') || '-'}</td><td>${data.financial.paymentStatus}</td></tr>
      <tr><td>موافقة البائع</td><td>${data.approvals.sellerApprovedAt?.toLocaleString('ar-YE') || '-'}</td><td>${data.approvals.sellerApprovedAt ? '✅ تم' : '⏳'}</td></tr>
      <tr><td>OTP البائع</td><td>${data.approvals.sellerOtpVerifiedAt?.toLocaleString('ar-YE') || '-'}</td><td>${data.approvals.sellerOtpVerifiedAt ? '✅ تم التحقق' : '⏳'}</td></tr>
      <tr><td>نقل الملكية</td><td>${data.transfer.transferDate.toLocaleString('ar-YE')}</td><td>${data.transfer.status}</td></tr>
      ${data.transfer.governmentReference ? `<tr><td>مرجع مزود المرور</td><td>${data.transfer.governmentReference}</td><td>صفة الاعتماد الرسمي يحددها المرور</td></tr>` : ''}
    </table>
  </div>

  <div class="section">
    <div class="section-title">الاستمارة الإلكترونية</div>
    <div style="font-size: 12px; background: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0;">
      <strong>تنبيه مهم:</strong> المنصة لا تطبع أو تنشئ استمارة مرور حكومية من نفسها. الاستمارة مرتبطة بالمرور.<br>
      بعد نجاح نقل الملكية يتم الحصول على الاستمارة/بياناتها من نظام المرور الرسمي عبر التكامل.<br>
      ${data.transfer.electronicDocumentUrl ? `رابط الاستمارة: ${data.transfer.electronicDocumentUrl}` : 'الاستمارة متاحة في: مركباتي → المركبة → الوثائق'}
    </div>
  </div>

  <div class="footer">
    <div class="grid">
      <div><strong>رقم مرجعي للعملية:</strong> ${data.operationId}</div>
      <div><strong>تاريخ العملية:</strong> ${data.createdAt.toLocaleString('ar-YE')}</div>
    </div>
    
    <div class="signature">
      <div class="sig-box">
        <div style="font-weight: 900;">توقيع البائع / إقرار الموافقة الإلكترونية</div>
        <div style="margin-top: 20px; font-size: 11px; color: #666;">تمت الموافقة إلكترونيا عبر OTP موثق</div>
        <div style="margin-top: 10px;">${data.seller.name}</div>
        <div style="margin-top: 5px; font-size: 10px;">${data.approvals.sellerOtpVerifiedAt?.toLocaleString('ar-YE') || ''}</div>
      </div>
      <div class="sig-box">
        <div style="font-weight: 900;">توقيع المشتري / إقرار الموافقة الإلكترونية</div>
        <div style="font-size: 11px; color: #666; margin-top: 20px;">تمت الموافقة إلكترونيا عبر OTP موثق</div>
        <div style="margin-top: 10px;">${data.buyer.name}</div>
        <div style="margin-top: 5px; font-size: 10px;">${data.approvals.buyerOtpVerifiedAt?.toLocaleString('ar-YE') || ''}</div>
      </div>
    </div>

    <div class="qr">
      <div style="font-size: 10px; color: #999; margin-top: 30px;">
        العقد صادر من منصة مركبات - رقم العقد ${data.contractNumber}<br>
        للتحقق: امسح QR أو أدخل رقم العقد في المنصة<br>
        هذا العقد ليس بديلا عن نموذج حكومي أو عقد قانوني معتمد إلى أن يتم اعتماده رسميا
      </div>
    </div>
  </div>
</body>
</html>
    `;
  }

}

export const contractPdfService = new ContractPdfService();
