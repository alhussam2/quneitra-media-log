// =====================================================================
//  إعدادات الاتصال
//
//  هاتان القيمتان عامّتان بالتصميم — يراهما أي زائر، ولا خطر في ذلك:
//  الحماية في سياسات RLS داخل قاعدة البيانات، لا في إخفاء المفتاح.
//  المفتاح الخطير (service_role) لا يوجد هنا ولا في أي ملف بالمستودع.
// =====================================================================

export const SUPABASE_URL = "https://sxfdahhkuakufcmwwmrw.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_cOFa7Fo79_KpeZRrwhyHzA_kqdmMveV";

// لازم يطابق EMAIL_DOMAIN في supabase/functions/admin-users/index.ts
export const USER_EMAIL_DOMAIN = "users.quneitra-media.app";

export const ORG = {
  directorate: "مديرية إعلام القنيطرة",
  section: "دائرة الإنتاج",
};

export const isConfigured = () =>
  SUPABASE_URL.startsWith("https://") && SUPABASE_ANON_KEY.length > 40;
