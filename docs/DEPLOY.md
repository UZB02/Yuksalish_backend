# VPS ga joylash yo'riqnomasi (AlmaLinux 10, Docker)

Bu yo'riqnoma loyihani Eskiz.uz VPS (AlmaLinux 10) ga joylashni qadam-baqadam tushuntiradi.

**Arxitektura:** serverda 3 ta konteyner ishlaydi.

| Konteyner | Vazifasi | Tashqariga ochiqmi |
|---|---|---|
| `web` (Caddy) | HTTPS (Let's Encrypt avtomatik), ikkala frontend statik, `/api` ni API ga yo'naltiradi | ha: 80, 443 |
| `api` | Node.js backend | yo'q |
| `mongo` | MongoDB 7 (parolli, ilova uchun alohida cheklangan foydalanuvchi) | yo'q |

Kod uchta alohida repoda (backend, admin, publik); deploy fayllari backend repoda. Docker BuildKit talab qilinadi (4-bo'lim).

Domenlar: ochiq reyting `PUBLIC_DOMAIN` da, admin panel `ADMIN_DOMAIN` da. Ochiq domen orqali faqat `/api/v1/public/*` ishlaydi, login endpointlari u yerda yopiq.

> Compose fayl, image build, sertifikat olish va frontend `vue-tsc` build'i hali haqiqiy Docker da sinab ko'rilmagan (Docker o'rnatilmagan muhitda tayyorlangan). Birinchi ishga tushirishda 7-bo'limdagi tekshiruvlarni bajaring.

---

## 0. Oldindan tayyorlash

1. **Domen kerak.** HTTPS siz tizimga kirib bo'lmaydi: refresh cookie `secure` bo'lgani uchun faqat HTTPS da ishlaydi, sertifikat olish esa domen talab qiladi. Faqat IP manzil bilan ishlamaydi. `.uz` domenini Eskiz.uz yoki boshqa registratordan olish mumkin.
2. **DNS da ikkita A-yozuv** yarating, ikkalasi ham VPS ning IP manziliga qarasin:
   - `reyting.example.uz` → `VPS_IP` (ochiq reyting)
   - `admin.reyting.example.uz` → `VPS_IP` (admin panel)
3. DNS tarqalishini kuting (odatda 5–60 daqiqa). Tekshirish: `nslookup reyting.example.uz`.
4. VPS ning root parolini yoki SSH kalitini Eskiz panelidan oling.

## 1. Serverga kirish va asosiy xavfsizlik

Windows PowerShell dan:

```powershell
ssh root@VPS_IP
```

Serverda (root sifatida):

```bash
dnf -y update
timedatectl set-timezone Asia/Tashkent

# Alohida foydalanuvchi (root bilan kundalik ishlamang)
useradd -m -G wheel yuksalish
passwd yuksalish

# SSH kalit bilan kirishni sozlang (quyida) va keyin parol bilan kirishni o'chiring
```

**SSH kalit (o'z kompyuteringizda, PowerShell):**

```powershell
ssh-keygen -t ed25519
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@VPS_IP "install -d -m 700 -o yuksalish -g yuksalish /home/yuksalish/.ssh && cat >> /home/yuksalish/.ssh/authorized_keys && chown yuksalish:yuksalish /home/yuksalish/.ssh/authorized_keys && chmod 600 /home/yuksalish/.ssh/authorized_keys"
ssh yuksalish@VPS_IP    # parolsiz kirsa, kalit ishlayapti
```

Kalit bilan kirish ishlashini **tekshirgandan keyingina**, serverda:

```bash
printf 'PermitRootLogin no\nPasswordAuthentication no\n' | sudo tee /etc/ssh/sshd_config.d/00-hardening.conf
sudo sshd -t && sudo systemctl restart sshd
```

(`00-` prefiksi muhim: SSH konfiguratsiyada birinchi o'qilgan qiymat amal qiladi, `sshd_config.d` dagi boshqa fayllar uni bekor qilmasin.) Eski sessiyani yopmasdan, yangi terminal ochib `ssh yuksalish@VPS_IP` bilan kirishni tekshiring.

RAM 2 GB dan kam bo'lsa, frontend build'i xotira yetishmasligidan to'xtashi mumkin. Swap qo'shing:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Firewall

```bash
sudo dnf -y install firewalld
sudo systemctl enable --now firewalld
sudo firewall-cmd --permanent --add-service=ssh --add-service=http --add-service=https
sudo firewall-cmd --permanent --add-port=443/udp     # HTTP/3
sudo firewall-cmd --reload
```

MongoDB (27017) va API (4000) portlari ochilmaydi va ochilmasligi kerak.

## 3. Docker o'rnatish

```bash
sudo dnf -y install dnf-plugins-core git nano openssl   # openssl: .env parollarini yaratish uchun (minimal AlmaLinux da yo'q)
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker yuksalish
# chiqib, qayta kiring (guruh o'zgarishi uchun), so'ng:
docker run --rm hello-world
docker compose version
```

Firewall sozlangandan keyin Docker tarmoq qoidalari to'g'ri o'rnashi uchun bir marta: `sudo systemctl restart docker`.

Agar AlmaLinux da oldindan `podman` yoki `runc` o'rnatilgan bo'lib Docker o'rnatishga to'sqinlik qilsa: `sudo dnf -y remove podman runc` va qayta urining.

## 4. Loyihani serverga ko'chirish

Loyiha **uchta alohida git repo** dan iborat. Serverda ular quyidagi papka tuzilmasida **yonma-yon** turishi shart (`web` image shu ota papkadan yig'iladi):

```
/opt/yuksalish/
├── Yuksalish_backend/          # API + docker-compose.prod.yml + deploy/ (.env shu yerda)
├── Yuksalish_Front/            # front repo; admin panel (Vue) ichidagi admin/ papkada
└── Yuksalish-publik/           # ochiq reyting (Vue)
```

**Variant A, git bilan (tavsiya).**

```bash
sudo mkdir -p /opt/yuksalish && sudo chown yuksalish:yuksalish /opt/yuksalish
cd /opt/yuksalish
git clone <BACKEND_REPO_URL>  Yuksalish_backend
git clone <FRONT_REPO_URL>    Yuksalish_Front           # admin panel Yuksalish_Front/admin ichida
git clone <PUBLIK_REPO_URL>   Yuksalish-publik
```

`<..._URL>` o'rniga o'z repolaringiz manzilini yozing. Repolar shaxsiy (private) bo'lsa, ikki yo'l bor:

- **Deploy key (tavsiya):** serverda `ssh-keygen -t ed25519 -f ~/.ssh/yuksalish_deploy -N ""` qiling, `.pub` faylni repo sozlamalarida "Deploy keys" ga (faqat o'qish) qo'shing va SSH manzil (`git@github.com:...`) bilan clone qiling. GitHub da bitta deploy key faqat bitta repoga qo'shiladi, shuning uchun har repo uchun alohida kalit yarating (`~/.ssh/config` da `Host` taxalluslari bilan) yoki bitta "machine user" ishlating.
- **HTTPS + token:** `https://<TOKEN>@github.com/<user>/<repo>.git` ko'rinishida (faqat o'qish huquqli token). Token `.git/config` da saqlanadi, uni boshqa joyga nusxalamang.

`.env` fayllar hech qaysi repoga tushmasligi shart (`.gitignore` ularni yopadi).

**Variant B, arxiv bilan (Windows PowerShell).** Uchala papkani bitta arxivga olamiz (`node_modules`, `dist`, `.git`, `.env*` siz):

```powershell
cd "D:\Proektlar\Yuksalish maktabi"
tar --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env --exclude=.env.* -czf "$env:TEMP\yuksalish.tgz" Yuksalish_backend Yuksalish_Front Yuksalish-publik
scp "$env:TEMP\yuksalish.tgz" yuksalish@VPS_IP:/tmp/
```

`.env.production` fayllar arxivga tushmaydi, bu zararsiz: `web.Dockerfile` kerakli qiymatlarni o'zi beradi. Serverda:

```bash
sudo mkdir -p /opt/yuksalish && sudo chown yuksalish:yuksalish /opt/yuksalish
tar -xzf /tmp/yuksalish.tgz -C /opt/yuksalish
ls /opt/yuksalish /opt/yuksalish/Yuksalish_backend    # Yuksalish_backend, Yuksalish_Front, Yuksalish-publik; docker-compose.prod.yml, deploy ...
```

Arxiv usulida keyingi yangilashlarda `update.sh` ni `SKIP_PULL=1` bilan ishlating (9-bo'lim).

> **Docker BuildKit kerak.** `web` image ning ignore qoidalari `deploy/web.Dockerfile.dockerignore` faylida (bu BuildKit xususiyati). Zamonaviy Docker CE da BuildKit sukut bo'yicha yoqilgan (3-bo'limdagi o'rnatish shuni beradi). Tekshirish: `docker buildx version`. BuildKit siz bu fayl e'tiborsiz qoladi va `node_modules`, `.env` kabi fayllar build kontekstiga tushib ketadi.

## 5. Sozlash (`.env`)

Barcha `docker compose` buyruqlari **`/opt/yuksalish/Yuksalish_backend`** papkasida bajariladi.

```bash
cd /opt/yuksalish/Yuksalish_backend
cp deploy/production.env.example .env
chmod 600 .env
# parollarni generatsiya qiling va .env ga yozing:
openssl rand -hex 24    # MONGO_ROOT_PASSWORD uchun
openssl rand -hex 24    # MONGO_APP_PASSWORD uchun
openssl rand -hex 48    # JWT_ACCESS_SECRET uchun
nano .env
```

`.env` dagi `COMPOSE_FILE=docker-compose.prod.yml` qatori qolsin: shunda `docker compose ...` o'zi production faylni ishlatadi.

To'ldirish shart bo'lganlar: `PUBLIC_DOMAIN`, `ADMIN_DOMAIN`, `ACME_EMAIL`, uchala parol/kalit va `SEED_SUPERADMIN_*`.

Muhim:
- `CHANGE_ME_...` qiymatlarini qoldirmang: API productionda namuna `JWT_ACCESS_SECRET` bilan ishga tushmaydi, seed esa namuna parolni rad etadi.
- Parollar uchun `openssl rand -hex` ishlating. Maxsus belgilar (`@`, `/`, `:`) Mongo ulanish manzilini buzadi.
- `JWT_ACCESS_SECRET` ni keyin almashtirmang: almashtirilsa, barcha foydalanuvchilar tizimdan chiqib ketadi va ochiq reytingdagi o'quvchi kalitlari o'zgaradi.
- Mongo parollari faqat **birinchi ishga tushishda** o'rnatiladi. Keyin `.env` dagi parolni o'zgartirsangiz, baza eskisini ishlatishda davom etadi va ulanish xato beradi.

Frontend `.env.production` fayllari repoda qoladi, lekin Docker build da `VITE_PUBLIC_URL` ni `web.Dockerfile` build argumenti (`https://PUBLIC_DOMAIN`) bekor qiladi: Vite da jarayon muhitidagi `VITE_*` o'zgaruvchilar `.env.*` fayllaridan ustun turadi. Domenni faqat serverdagi `.env` da bering.

## 6. Ishga tushirish

```bash
cd /opt/yuksalish/Yuksalish_backend
docker compose up -d --build
docker compose ps         # uchala servis ham "running"/"healthy" bo'lishi kerak
docker compose logs -f web api    # Ctrl+C bilan chiqish
```

Birinchi build 5–15 daqiqa olishi mumkin (frontendlar yig'iladi).

**Superadminni yaratish** (bir marta):

```bash
docker compose exec api node dist/scripts/seed.js
```

Keyin admin panelga kiring, parolni profildan o'zgartiring, so'ng `.env` dan `SEED_SUPERADMIN_PASSWORD` qiymatini o'chirib, `docker compose up -d` ni qayta ishga tushiring.

Demo ma'lumot (`seed:demo`) productionda **ishlatmang**.

## 7. Tekshiruv

```bash
cd /opt/yuksalish/Yuksalish_backend
curl -sI https://ADMIN_DOMAIN | head -3                          # HTTP/2 200
curl -s  https://PUBLIC_DOMAIN/api/v1/public/schools             # {"success":true,"data":[...]}
curl -s -o /dev/null -w "%{http_code}\n" https://PUBLIC_DOMAIN/api/v1/auth/me   # 404 (ochiq domenda yopiq)
docker compose exec api node -e "fetch('http://127.0.0.1:4000/health').then(r=>r.text()).then(console.log)"   # db: connected
```

API image da `wget`/`curl` yo'q (bookworm-slim), shuning uchun health `node` bilan tekshiriladi; compose healthcheck ham shuni ishlatadi.

Brauzerda: admin domenga kiring, login qiling, sinf yarating, bir baho qo'ying; ochiq domenda maktab sahifasi ochilishini tekshiring.

## 8. Zaxira nusxa (backup)

```bash
sudo dnf -y install cronie && sudo systemctl enable --now crond
chmod +x /opt/yuksalish/Yuksalish_backend/deploy/*.sh
sed -i 's/\r$//' /opt/yuksalish/Yuksalish_backend/deploy/*.sh      # Windows qatori oxirini tozalash (zararsiz)
/opt/yuksalish/Yuksalish_backend/deploy/backup.sh                  # qo'lda sinab ko'ring
( crontab -l 2>/dev/null; echo '0 3 * * * /opt/yuksalish/Yuksalish_backend/deploy/backup.sh >> $HOME/yuksalish-backup.log 2>&1' ) | crontab -
```

Skript Mongo parolini `Yuksalish_backend/.env` dan o'zi o'qiydi. Nusxalar `/var/backups/yuksalish/` ga yoziladi va 14 kundan keyin o'chiriladi (`.env` da `BACKUP_DIR`, `BACKUP_KEEP_DAYS`). Agar `/var/backups` ga yozish huquqi bo'lmasa: `sudo mkdir -p /var/backups/yuksalish && sudo chown yuksalish /var/backups/yuksalish`.

> Bitta VPS dagi zaxira VPS yo'qolsa ham yo'qoladi. Nusxalarni vaqti-vaqti bilan boshqa joyga (o'z kompyuteringiz yoki boshqa server) ko'chiring, masalan: `scp yuksalish@VPS_IP:/var/backups/yuksalish/*.gz D:\Zaxira\`.

**Zaxiradan tiklash** (TZ talab qilganidek, kamida bir marta sinab ko'ring):

```bash
cd /opt/yuksalish/Yuksalish_backend
docker compose exec -T mongo sh -c \
  'mongorestore -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip --drop' \
  < /var/backups/yuksalish/yuksalish_YYYY-MM-DD_HHMM.archive.gz
docker compose restart api
```

## 9. Yangilash (yangi versiya chiqarganda)

```bash
cd /opt/yuksalish/Yuksalish_backend
./deploy/update.sh              # zaxira -> 3 ta repo da git pull --ff-only -> build + up -> api health kutish
SKIP_PULL=1 ./deploy/update.sh  # kod qo'lda ko'chirilgan bo'lsa (arxiv usuli): pull qilmaydi
```

Papkalar `update.sh` boshida o'zgaruvchilar (`ROOT_DIR`, `BACKEND_DIR`, `ADMIN_DIR`, `PUBLIC_DIR`); sukut bo'yicha `/opt/yuksalish/...`. Skript avval zaxira oladi: zaxira muvaffaqiyatsiz bo'lsa, yangilash to'xtaydi. `git pull --ff-only` lokal o'zgarishlar yoki ajralgan tarix bo'lsa xato beradi (jimgina merge qilmaydi).

`.env` ga tegilmaydi. Ma'lumotlar Docker volume larida saqlanadi, yangilashda yo'qolmaydi. **`docker compose down -v` ni hech qachon ishlatmang**: `-v` bazani va sertifikatlarni o'chiradi.

## 10. Muammolar

| Alomat | Sabab va yechim |
|---|---|
| Sertifikat olinmayapti, brauzer xato beradi | DNS hali tarqalmagan yoki 80/443 yopiq. `docker compose logs web` ni ko'ring; `dig +short DOMAIN` serverning IP sini qaytarishi kerak. |
| Login qilganda darhol chiqib ketadi | HTTP orqali kirilgan. Faqat `https://` bilan oching (cookie `secure`). |
| "So'rovlar juda ko'p" (429) hamma uchun | `TRUST_PROXY` 1 bo'lishi kerak (compose da o'rnatilgan). `docker compose exec api printenv TRUST_PROXY` bilan tekshiring. |
| `api` ishga tushmaydi, Mongo autentifikatsiya xatosi | `.env` dagi Mongo parollari baza yaratilgandan keyin o'zgartirilgan. Hali ma'lumot bo'lmasa: `docker compose down -v` va qayta `up`. Ma'lumot bor bo'lsa, eski parollarni qaytaring. |
| Frontend build `out of memory` | Swap qo'shing (1-bo'lim) yoki RAM ni oshiring. |
| Frontend build `vue-tsc` xatosi | Kodda tip xatosi bor: lokal kompyuterda `npm run build` ni ishga tushirib to'g'rilang. |
| Admin ilovasi (PWA) da muammo: eski versiya qotib qolgan, offline holat xato | **Kill-switch:** serverdagi `.env` ga `VITE_PWA_KILL=1` yozing va `./deploy/update.sh` ni ishga tushiring. Admin service worker keyingi tashrifda o'zini o'chiradi va keshini tozalaydi. Tuzalgach `VITE_PWA_KILL=0` (yoki qatorni o'chirish) va yana `update.sh`. `sw.js` faylini qo'lda o'chirmang: Caddy fallback sifatida `index.html` qaytaradi va eski worker abadiy qolib ketadi. |
| Sahifani yangilaganda 404 | Caddy `try_files` bilan SPA fallback qiladi; agar chiqsa, `docker compose logs web` ni ko'ring. |

Foydali buyruqlar (hammasi `/opt/yuksalish/Yuksalish_backend` da): `docker compose ps`, `docker compose logs --tail=100 api`, `docker compose restart api`, `docker stats`.

## 11. Qo'shimcha xavfsizlik (tavsiya)

- Avtomatik xavfsizlik yangilanishlari: `sudo dnf -y install dnf-automatic && sudo systemctl enable --now dnf-automatic-install.timer`
- SSH brute-force dan himoya: `fail2ban` (EPEL repo orqali).
- Swagger (`/api/docs`) productionda o'chiq (`ENABLE_DOCS=false`). Kerak bo'lsa vaqtincha yoqing.
- `.env` faylini hech kimga yubormang va repoga qo'shmang.
