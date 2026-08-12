
// lib/advertisement.ts - نظام الإعلانات - مركبات V11 - 15 ثانية دوران

export type AdStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'ARCHIVED';
export type AdPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Advertisement {
  id: string;
  title: string;
  description?: string;
  imageUrl?: string;
  mediaUrl?: string;
  targetUrl?: string;
  startDate: Date;
  endDate: Date;
  durationSeconds: number; // مدة عرض الإعلان - افتراضي 15 ثانية
  priority: AdPriority;
  displayOrder: number;
  status: AdStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  impressions: number;
  clicks: number;
}

export class AdvertisementService {
  private ads: Map<string, Advertisement> = new Map();
  private currentIndex: number = 0;

  async createAdvertisement(params: {
    title: string;
    description?: string;
    imageUrl?: string;
    mediaUrl?: string;
    targetUrl?: string;
    startDate: Date;
    endDate: Date;
    durationSeconds?: number;
    priority?: AdPriority;
    displayOrder?: number;
    createdBy: string;
  }): Promise<Advertisement> {
    const ad: Advertisement = {
      id: `AD-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      title: params.title,
      description: params.description,
      imageUrl: params.imageUrl,
      mediaUrl: params.mediaUrl,
      targetUrl: params.targetUrl,
      startDate: params.startDate,
      endDate: params.endDate,
      durationSeconds: params.durationSeconds || 15, // افتراضي 15 ثانية
      priority: params.priority || 'MEDIUM',
      displayOrder: params.displayOrder || 0,
      status: 'DRAFT',
      createdBy: params.createdBy,
      createdAt: new Date(),
      updatedAt: new Date(),
      impressions: 0,
      clicks: 0,
    };

    this.ads.set(ad.id, ad);

    console.log(`[ADS] Created advertisement ${ad.id} - ${params.title} - Duration: ${ad.durationSeconds}s`);

    return ad;
  }

  async activateAd(adId: string, activatedBy: string): Promise<Advertisement> {
    const ad = this.ads.get(adId);
    if (!ad) throw new Error('Ad not found');

    ad.status = 'ACTIVE';
    ad.updatedAt = new Date();
    this.ads.set(adId, ad);

    return ad;
  }

  async pauseAd(adId: string, pausedBy: string): Promise<Advertisement> {
    const ad = this.ads.get(adId);
    if (!ad) throw new Error('Ad not found');

    ad.status = 'PAUSED';
    ad.updatedAt = new Date();
    this.ads.set(adId, ad);

    return ad;
  }

  async archiveAd(adId: string, archivedBy: string): Promise<Advertisement> {
    const ad = this.ads.get(adId);
    if (!ad) throw new Error('Ad not found');

    ad.status = 'ARCHIVED';
    ad.updatedAt = new Date();
    this.ads.set(adId, ad);

    return ad;
  }

  getActiveAds(): Advertisement[] {
    const now = new Date();
    return Array.from(this.ads.values())
      .filter(ad => 
        ad.status === 'ACTIVE' && 
        ad.startDate <= now && 
        ad.endDate >= now
      )
      .sort((a, b) => {
        // ترتيب حسب Priority ثم DisplayOrder
        const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
          return priorityOrder[a.priority] - priorityOrder[b.priority];
        }
        return a.displayOrder - b.displayOrder;
      });
  }

  // الحصول على الإعلان التالي في الدوران - كل 15 ثانية
  getNextAdInRotation(): Advertisement | null {
    const activeAds = this.getActiveAds();
    if (activeAds.length === 0) return null;

    // مثال: 4 إعلانات - كل واحد 15 ثانية - ثم يعود 1→2→3→4→1...
    const ad = activeAds[this.currentIndex % activeAds.length];
    this.currentIndex = (this.currentIndex + 1) % activeAds.length;

    // زيادة Impressions
    ad.impressions += 1;
    this.ads.set(ad.id, ad);

    return ad;
  }

  // للواجهة الأمامية - مصفوفة الإعلانات مع التوقيت
  getRotationSchedule(): { ad: Advertisement; startSecond: number; endSecond: number }[] {
    const activeAds = this.getActiveAds();
    let currentSecond = 0;

    return activeAds.map(ad => {
      const schedule = {
        ad,
        startSecond: currentSecond,
        endSecond: currentSecond + ad.durationSeconds,
      };
      currentSecond += ad.durationSeconds;
      return schedule;
    });
  }

  async recordClick(adId: string): Promise<void> {
    const ad = this.ads.get(adId);
    if (ad) {
      ad.clicks += 1;
      this.ads.set(adId, ad);
    }
  }

  // تنظيف تلقائي للإعلانات المنتهية
  cleanupExpired(): number {
    const now = new Date();
    let count = 0;

    for (const [id, ad] of this.ads.entries()) {
      if (ad.endDate < now && ad.status === 'ACTIVE') {
        ad.status = 'ENDED';
        ad.updatedAt = new Date();
        this.ads.set(id, ad);
        count++;
      }
    }

    return count;
  }

  getAd(id: string): Advertisement | undefined {
    return this.ads.get(id);
  }

  getAllAds(): Advertisement[] {
    return Array.from(this.ads.values());
  }
}

export const advertisementService = new AdvertisementService();
