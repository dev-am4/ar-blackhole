# Black Hole AR · Zone 2 Big Bang Dome · นครสวรรค์

สื่อ WebAR **เสริมการเรียนรู้** สำหรับโครงการปรับปรุงนิทรรศการดาราศาสตร์และอวกาศ ณ **ศูนย์วิทยาศาสตร์เพื่อการศึกษานครสวรรค์**

> บทบาทของระบบนี้คือกิจกรรมต่อยอดจาก **Zone 2 · Big Bang Dome** เท่านั้น ไม่ใช่สื่อหลักของ Dome และไม่แทน workflow Fulldome / Projection ของพื้นที่หลัก

## Narrative ในโครงการ

ประสบการณ์หลักของ Zone 2 พาผู้ชมติดตามเรื่องราว **กำเนิดเอกภพ** ตั้งแต่เอกภพยุคแรกที่ร้อนและหนาแน่น การขยายตัวของอวกาศ การก่อกำเนิดอนุภาค นิวเคลียส CMB ยุคมืด ดาวฤกษ์ และโครงสร้างขนาดใหญ่ของจักรวาล

Black Hole AR ใช้เป็นกิจกรรมต่อยอดหลังจากนั้น เพื่อพาผู้ชมสำรวจแนวคิดเรื่อง **แรงโน้มถ่วงสุดขั้ว** ผ่านวัตถุที่สามารถวางลงในพื้นที่จริงได้

### หลักการสื่อสารทางวิทยาศาสตร์

- ห้ามสื่อว่าหลุมดำคือ “Big Bang” หรือเกิดขึ้นพร้อม Big Bang โดยตรง
- Big Bang ในเนื้อหาหลักอธิบายว่าเป็นการขยายตัวของอวกาศ ไม่ใช่การระเบิดของวัตถุออกไปในอวกาศว่างเปล่า
- หลุมดำมวลดาวฤกษ์สามารถเกิดภายหลังจากการยุบตัวของดาวฤกษ์มวลมาก
- ต้นกำเนิดของหลุมดำมวลยิ่งยวดเป็นหัวข้อวิจัยที่ยังมีคำถามสำคัญ
- เมื่อวัตถุผ่าน **Event Horizon / ขอบฟ้าเหตุการณ์** แล้ว แม้แต่แสงก็ไม่สามารถกลับออกมาได้
- นอก Event Horizon วัตถุยังสามารถโคจรรอบหลุมดำได้ ไม่ใช่ทุกสิ่งจะถูก “ดูด” เข้าไปทันที

## Visitor Flow

1. ผู้ชมออกจาก/ต่อยอดจากประสบการณ์ **Big Bang Dome**
2. สแกน QR หรือเปิด Black Hole AR บนมือถือ
3. แตะ **เปิดกล้อง · สำรวจหลุมดำ**
4. ระบบจับพื้นด้วย WebXR hit-test บน Android หรือใช้กล้อง + ไจโรเป็น fallback
5. ผู้ชมวางหลุมดำลงบนพื้นที่จริง
6. Android WebXR: เดินเข้าใกล้แล้ว Gravity Field เพิ่มขึ้นตามระยะ
7. iPhone/fallback: แตะค้างหรือกด **เร่งแรงดูด** เพื่อเพิ่ม interaction
8. Accretion disk, halo และอนุภาคตอบสนองแบบ realtime

## Experience Positioning

**Main exhibit:** Zone 2 · Big Bang Dome  
**Supplement:** Black Hole AR · Extreme Gravity  
**Venue:** ศูนย์วิทยาศาสตร์เพื่อการศึกษานครสวรรค์  
**Purpose:** Reinforce astronomy concepts through short mobile interaction after the immersive dome experience

AR ควรใช้เป็นกิจกรรมสั้น เข้าใจง่าย และไม่แย่งจังหวะจากสื่อหลักใน Dome

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
- ข้อความวิทยาศาสตร์ใน UI เชื่อมกับ Big Bang Dome
- `?debug=1` สำหรับเปิด HUD ตรวจค่าระบบ

## Browser modes

### Android Chrome / WebXR

ใช้ `immersive-ar` + `hit-test` ทำ 6DoF tracking และวัดระยะจากกล้องถึงหลุมดำจริง ผู้ชมสามารถเดินเข้าใกล้/ถอยห่างเพื่อเปลี่ยน Gravity Field ได้

### iPhone Safari / Fallback

iOS Safari ใน workflow นี้ใช้กล้องหลัง + DeviceOrientation เพื่อให้วัตถุเคลื่อนไหวสัมพันธ์กับทิศทางมือถือ และใช้ touch interaction สำหรับ Gravity Field

## Routes

ทุก route หน้างานเรียก experience เดียวกัน

- `/`
- `/blackhole`
- `/p1`
- `/p2`
- `/p3`

`fast.html` เป็น legacy redirect กลับหน้า Black Hole หลัก

## Files

```text
index.html       Nakhon Sawan / Zone 2 entry UI
blackhole.css    Space UI + exhibition branding + AR overlay
blackhole.js     Three.js, WebXR, shader, particles, interaction
vercel.json      Routes + cache headers
diag.html        Diagnostic page
```

ไฟล์ `tulip.mp4`, `butterfly.mp4`, `mushroom.mp4` และ `thumbs/` เป็น asset จาก AR เวอร์ชันเดิม ปัจจุบัน Black Hole runtime ไม่เรียกใช้งาน เก็บไว้ชั่วคราวสำหรับ rollback ได้

## Deploy

เป็น static project ใช้ Vercel ได้โดยตรง และต้องเสิร์ฟผ่าน HTTPS เพื่อให้เบราว์เซอร์อนุญาตกล้อง/WebXR

```bash
vercel deploy --prod
```

## ทดสอบก่อนใช้หน้างาน

- หน้าแรกแสดงชื่อ **ศูนย์วิทยาศาสตร์เพื่อการศึกษานครสวรรค์** และ `Zone 2 · Big Bang Dome · AR Learning Extension`
- ข้อความชัดเจนว่าเป็นสื่อเสริม ไม่ใช่ประสบการณ์หลักของ Dome
- Android Chrome: เปิด `immersive-ar` ได้และ reticle จับพื้น
- เดินเข้าหาหลุมดำแล้ว Gravity Field เพิ่มขึ้นจริง
- iPhone Safari: อนุญาตกล้องและ Motion & Orientation
- iPhone: แตะค้าง/ปุ่มเร่งแรงดูดทำงาน
- Pinch scale ไม่ทำให้วัตถุใหญ่เกินพื้นที่
- ทดสอบในระดับแสงจริงของนิทรรศการ เพราะห้องมืดเกินไปทำให้ visual tracking แย่ลง
- เช็กเสียงกับสภาพแวดล้อมหน้างาน ไม่ให้เสียง AR รบกวน soundtrack ของ Dome

## Debug

เปิด:

```text
/?debug=1
```

HUD จะแสดง mode, placement state, gravity, camera/core position และ scale

หากกล้องไม่เปิด ให้เปิด `/diag.html` เพื่อตรวจ secure context, camera API, WebXR และ motion sensor support
