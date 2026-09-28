// Firebase 網頁設定：這組值本來就是公開的（瀏覽器一定看得到），
// 真正的保護是 firestore.rules（只有 OWNER_EMAIL 能寫入）＋ API key 的網域限制。
window.APP_CONFIG = {
  OWNER_EMAIL: "uponion129@gmail.com",
  firebase: {
    apiKey: "AIzaSyD4lY1I19VnFgsQpRCuafN41GtLffcu-Dg",
    authDomain: "im-board-2026.firebaseapp.com",
    projectId: "im-board-2026",
    storageBucket: "im-board-2026.firebasestorage.app",
    messagingSenderId: "1040387606227",
    appId: "1:1040387606227:web:2994e974f326174ea0b626",
  },
};
