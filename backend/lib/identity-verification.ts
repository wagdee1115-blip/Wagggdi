
// lib/identity-verification.ts - توثيق الهوية - مركبات V11 - AI + OCR + Face Match + Liveness

export type IdentityDocumentType = 'NATIONAL_ID' | 'PASSPORT';
export type VerificationStatus = 'PENDING' | 'PASS' | 'FAIL' | 'REVIEW';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface IdentityDocument {
  id: string;
  userId: string;
  documentType: IdentityDocumentType;
  frontImageUrl?: string;
  backImageUrl?: string;
  selfieImageUrl?: string;
  extractedData?: {
    fullName?: string;
    nationalId?: string;
    dateOfBirth?: string;
    expiryDate?: string;
    documentNumber?: string;
  };
  ocrConfidence?: number;
  status: VerificationStatus;
  riskLevel: RiskLevel;
  aiAnalysis?: {
    tamperingDetected: boolean;
    tamperingScore: number;
    faceMatchScore?: number;
    livenessScore?: number;
    documentAuthenticityScore: number;
    riskFactors: string[];
  };
  reviewedBy?: string;
  reviewedAt?: Date;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AIProvider {
  name: string;
  performOCR(imageUrl: string): Promise<{ text: string; confidence: number; extractedData: any }>;
  detectTampering(imageUrl: string): Promise<{ tampered: boolean; score: number; reasons: string[] }>;
  faceMatch(documentImageUrl: string, selfieImageUrl: string): Promise<{ match: boolean; score: number }>;
  livenessCheck(selfieImageUrl: string): Promise<{ live: boolean; score: number; spoofDetected: boolean }>;
  riskAssessment(document: IdentityDocument): Promise<{ riskLevel: RiskLevel; factors: string[] }>;
}

export class MockAIProvider implements AIProvider {
  name = 'MOCK_AI_VERIFICATION';

  async performOCR(imageUrl: string) {
    console.log(`[MOCK AI] OCR for ${imageUrl}`);
    return {
      text: 'Mock OCR Text - بيانات تجريبية',
      confidence: 0.95,
      extractedData: {
        fullName: 'مستخدم تجريبي',
        nationalId: '1234567890',
        dateOfBirth: '1990-01-01',
      },
    };
  }

  async detectTampering(imageUrl: string) {
    return {
      tampered: false,
      score: 0.05,
      reasons: [],
    };
  }

  async faceMatch(documentImageUrl: string, selfieImageUrl: string) {
    return {
      match: true,
      score: 0.92,
    };
  }

  async livenessCheck(selfieImageUrl: string) {
    return {
      live: true,
      score: 0.96,
      spoofDetected: false,
    };
  }

  async riskAssessment(document: IdentityDocument) {
    return {
      riskLevel: 'LOW' as RiskLevel,
      factors: [],
    };
  }
}

class UnconfiguredAIProvider implements AIProvider {
  async extractDocumentData(): Promise<any> { throw new Error('NOT_CONFIGURED:KYC_PROVIDER_REQUIRED'); }
  async compareFaces(): Promise<any> { throw new Error('NOT_CONFIGURED:KYC_PROVIDER_REQUIRED'); }
  async livenessCheck(): Promise<any> { throw new Error('NOT_CONFIGURED:KYC_PROVIDER_REQUIRED'); }
}

export class IdentityVerificationService {
  private documents: Map<string, IdentityDocument> = new Map();
  private aiProvider: AIProvider;

  constructor(aiProvider?: AIProvider) {
    this.aiProvider = aiProvider || ((process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') ? new MockAIProvider() : new UnconfiguredAIProvider());
  }

  async submitDocument(params: {
    userId: string;
    documentType: IdentityDocumentType;
    frontImageUrl: string;
    backImageUrl?: string;
    selfieImageUrl: string;
  }): Promise<IdentityDocument> {
    const doc: IdentityDocument = {
      id: `ID-DOC-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      userId: params.userId,
      documentType: params.documentType,
      frontImageUrl: params.frontImageUrl,
      backImageUrl: params.backImageUrl,
      selfieImageUrl: params.selfieImageUrl,
      status: 'PENDING',
      riskLevel: 'LOW',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.documents.set(doc.id, doc);

    // بدء التحقق التلقائي
    this.verifyDocument(doc.id).catch(console.error);

    return doc;
  }

  private async verifyDocument(documentId: string): Promise<IdentityDocument> {
    const doc = this.documents.get(documentId);
    if (!doc) throw new Error('Document not found');

    try {
      // OCR
      const ocrResult = await this.aiProvider.performOCR(doc.frontImageUrl!);
      doc.extractedData = ocrResult.extractedData;
      doc.ocrConfidence = ocrResult.confidence;

      // كشف التلاعب
      const tamperingResult = await this.aiProvider.detectTampering(doc.frontImageUrl!);
      
      // Face Match
      let faceMatchResult = null;
      if (doc.selfieImageUrl) {
        faceMatchResult = await this.aiProvider.faceMatch(doc.frontImageUrl!, doc.selfieImageUrl);
      }

      // Liveness
      let livenessResult = null;
      if (doc.selfieImageUrl) {
        livenessResult = await this.aiProvider.livenessCheck(doc.selfieImageUrl);
      }

      // Risk Assessment
      const riskResult = await this.aiProvider.riskAssessment(doc);

      doc.aiAnalysis = {
        tamperingDetected: tamperingResult.tampered,
        tamperingScore: tamperingResult.score,
        faceMatchScore: faceMatchResult?.score,
        livenessScore: livenessResult?.score,
        documentAuthenticityScore: 1 - tamperingResult.score,
        riskFactors: [...tamperingResult.reasons, ...riskResult.factors],
      };

      doc.riskLevel = riskResult.riskLevel;

      // تحديد الحالة النهائية - AI لا يكون وحده صاحب القرار في الحالات غير المؤكدة
      if (tamperingResult.tampered || (livenessResult && !livenessResult.live)) {
        doc.status = 'FAIL';
        doc.rejectionReason = 'Tampering or spoofing detected';
      } else if (
        (faceMatchResult && faceMatchResult.score < 0.7) ||
        (ocrResult.confidence < 0.6) ||
        riskResult.riskLevel === 'HIGH' ||
        riskResult.riskLevel === 'CRITICAL'
      ) {
        doc.status = 'REVIEW'; // يذهب لمراجعة إدارية
      } else {
        doc.status = 'PASS';
      }

      doc.updatedAt = new Date();
      this.documents.set(documentId, doc);

      console.log(`[IDENTITY] Document ${documentId} verification: ${doc.status} - Risk: ${doc.riskLevel}`);

      return doc;

    } catch (error: any) {
      doc.status = 'REVIEW';
      doc.updatedAt = new Date();
      this.documents.set(documentId, doc);
      console.error(`[IDENTITY] Verification failed for ${documentId}:`, error.message);
      return doc;
    }
  }

  async reviewDocument(params: {
    documentId: string;
    reviewedBy: string;
    decision: 'PASS' | 'FAIL';
    reason?: string;
  }): Promise<IdentityDocument> {
    const doc = this.documents.get(params.documentId);
    if (!doc) throw new Error('Document not found');

    if (doc.status !== 'REVIEW') {
      throw new Error('Document not in REVIEW status');
    }

    doc.status = params.decision;
    doc.reviewedBy = params.reviewedBy;
    doc.reviewedAt = new Date();
    doc.rejectionReason = params.reason;
    doc.updatedAt = new Date();

    this.documents.set(params.documentId, doc);

    console.log(`[IDENTITY] Document ${params.documentId} manually reviewed by ${params.reviewedBy}: ${params.decision}`);

    return doc;
  }

  getDocument(id: string): IdentityDocument | undefined {
    return this.documents.get(id);
  }

  getDocumentsByUser(userId: string): IdentityDocument[] {
    return Array.from(this.documents.values()).filter(d => d.userId === userId);
  }

  getPendingReview(): IdentityDocument[] {
    return Array.from(this.documents.values()).filter(d => d.status === 'REVIEW');
  }
}

export const identityVerificationService = new IdentityVerificationService();
