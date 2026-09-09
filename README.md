# Black Hole · WebAR

Markerless WebAR สำหรับงาน Interactive Space Experience เปิดผ่านเบราว์เซอร์มือถือโดยไม่ต้องติดตั้งแอป

## Experience

1. ผู้ชมแตะ **เปิดกล้อง · เริ่ม AR**
2. ระบบจับพื้นด้วย WebXR hit-test บน Android หรือใช้กล้อง + ไจโรเป็น fallback
3. ผู้ชมวางหลุมดำลงบนพื้นจริง
4. เมื่อเดินเข้าใกล้ในโหมด WebXR ค่า Gravity Field จะเพิ่มขึ้นอัตโนมัติ
5. บน iPhone/fallback ใช้การแตะค้างหรือปุ่ม **เร่งแรงดูด** เพื่อเพิ่มแรงโน้มถ่วง
6. Accretion disk, halo และอนุภาคถูกสร้างแบบ realtime ด้วย Three.js + GLSL ไม่พึ่งวิดีโอ MP4

## ฟีเจอร์หลัก

- Event Horizon 3D
- Procedural accretion disk shader
- Gravitational halo / lensing simulation
- 900 GPU particles โคจรและตกเข้าหาศูนย์กลาง
- Gravity strength ตามระยะกล้องใน WebXR
- Haptic vibration เมื่อแรงโน้มถ่วงสูง
- Low-frequency WebAudio ambience ที่ตอบสนองตาม Gravity Field
- Pinch สองนิ้วเพื่อย่อ/ขยาย
- ย้ายตำแหน่งหลุมดำได้โดยไม่ต้อง reload
- `?debug=1` สำหรับเปิด HUD ตรวจค่าระบบ

## Browser modes

### Android Chrome / WebXR

ใช้ `immersive-ar` + `hit-test` ทำ 6DoF tracking และวัดระยะจากกล้องถึงหลุมดำจริง ผู้ชมสามารถเดินเข้าใกล้/ถอยห่างเพื่อเปลี่ยนแรงโน้มถ่วงได้

### iPhone Safari / Fallback

iOS Safari ยังไม่มี WebXR immersive-ar แบบเดียวกับ Android ใน workflow นี้ จึงใช้กล้องหลัง + DeviceOrientation เพื่อให้วัตถุเคลื่อนไหวสัมพันธ์กับทิศทางมือถือ และใช้ touch interaction สำหรับ Gravity Field

## Routes

ทุก route หน้างานเรียก experience เดียวกัน

- `/`
- `/blackhole`
- `/p1`
- `/p2`
- `/p3`

`fast.html` เก็บไว้เป็น legacy redirect กลับหน้า Black Hole หลัก

## Files

```text
index.html       UI / entry page
blackhole.css    Space UI + AR overlay
blackhole.js     Three.js, WebXR, shader, particles, interaction
vercel.json      Routes + cache headers
diag.html        Diagnostic page
```

ไฟล์ `tulip.mp4`, `butterfly.mp4`, `mushroom.mp4` และ `thumbs/` เป็น asset จาก AR เวอร์ชันเดิม ปัจจุบัน Black Hole ไม่เรียกใช้งาน สามารถเก็บไว้สำหรับ rollback หรือค่อยลบหลังทดสอบ production ผ่านแล้ว

## Deploy

เป็น static project ใช้ Vercel ได้โดยตรง และต้องเสิร์ฟผ่าน HTTPS เพื่อให้เบราว์เซอร์อนุญาตกล้อง/WebXR

```bash
vercel deploy --prod
```

## ทดสอบก่อนใช้หน้างาน

- Android Chrome: เปิด `immersive-ar` ได้และ reticle จับพื้น
- เดินเข้าหาหลุมดำแล้ว Gravity Field เพิ่มขึ้นจริง
- iPhone Safari: อนุญาตกล้องและ Motion & Orientation
- iPhone: แตะค้าง/ปุ่มเร่งแรงดูดทำงาน
- Pinch scale ไม่ทำให้วัตถุใหญ่เกินพื้นที่
- ทดสอบในระดับแสงจริงของนิทรรศการ เพราะห้องมืดเกินไปจะทำให้ visual tracking ของ WebXR แย่ลง
- เช็กเสียงกับลำโพงหน้างานก่อนเปิดจริง เพราะมี sub-frequency ambience

## Debug

เปิด:

```text
/?debug=1
```

HUD จะแสดง mode, placement state, gravity, camera/core position และ scale

หากกล้องไม่เปิด ให้เปิด `/diag.html` เพื่อตรวจ secure context, camera API, WebXR และ motion sensor support
