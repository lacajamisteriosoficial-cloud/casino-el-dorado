# 🎰 Casino El Dorado

Plataforma de casino online con 5 juegos, autenticación JWT, panel admin unificado y pagos con MercadoPago.

## 🎮 Juegos incluidos
- **Blackjack** — vs Casa, con opción de doblar
- **Truco** — vs CPU, con truco y envido
- **Ludo** — Carrera de fichas vs 2 CPUs
- **Jackpot** — Slots, un solo ganador se lleva el pozo
- **Caja Misteriosa** — Juego en vivo administrado manualmente

En todos los juegos, la casa retiene el 20% y el ganador recibe el 80% restante.

## 🛠 Stack
- **Backend:** Node.js + Express
- **Base de datos:** PostgreSQL (Render managed)
- **Auth:** JWT + bcryptjs + rate limiting + Helmet
- **Pagos:** MercadoPago Checkout Pro
- **Deploy:** Render.com

## 🚀 Setup Local

### 1. Clonar el repo
```bash
git clone https://github.com/TU_USUARIO/casino-eldorado
cd casino-eldorado
```

### 2. Instalar dependencias
```bash
npm install
```

### 3. Configurar variables de entorno
```bash
cp .env.example .env
# Editar .env con tus valores
```

### 4. Crear la base de datos PostgreSQL local
```bash
# Con psql:
createdb casino_eldorado
psql casino_eldorado < api/db/schema.sql
```

### 5. Iniciar el servidor
```bash
npm start
# o para desarrollo:
npm run dev
```

### 6. Abrir en el browser
- **Casino:** http://localhost:3000
- **Admin:** http://localhost:3000/admin

## 🌐 Deploy en Render

### 1. Subir a GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TU_USUARIO/casino-eldorado.git
git push -u origin main
```

### 2. En Render.com
1. Crear cuenta en render.com
2. New → Blueprint (seleccioná el repo)
3. Render lee el `render.yaml` automáticamente y crea:
   - El web service
   - La base de datos PostgreSQL
4. Configurar las variables de entorno secretas en el dashboard:
   - `ADMIN_USER` → nombre del admin (ej: `admin`)
   - `ADMIN_PASSWORD` → contraseña segura del admin
   - `MP_ACCESS_TOKEN` → tu token de MercadoPago
   - `MP_PUBLIC_KEY` → tu clave pública de MercadoPago
   - `ALLOWED_ORIGIN` → la URL de tu app en Render (ej: `https://casino-eldorado.onrender.com`)

### 3. Correr el schema SQL
En Render → tu base de datos → Shell:
```sql
\i /path/to/schema.sql
```
O copiá y pegá el contenido de `api/db/schema.sql` directamente en el shell.

## 🔐 Variables de Entorno

| Variable | Descripción |
|---|---|
| `PORT` | Puerto del servidor (default: 3000) |
| `DATABASE_URL` | URL completa de PostgreSQL (Render la setea auto) |
| `JWT_SECRET` | Secret para tokens de usuarios (string largo random) |
| `ADMIN_JWT_SECRET` | Secret para tokens de admin (diferente al anterior) |
| `ADMIN_USER` | Usuario del panel admin |
| `ADMIN_PASSWORD` | Contraseña del panel admin |
| `MP_ACCESS_TOKEN` | Token de acceso MercadoPago |
| `MP_PUBLIC_KEY` | Clave pública MercadoPago |
| `ALLOWED_ORIGIN` | Dominio permitido para CORS |

## 📁 Estructura del Proyecto
```
casino-eldorado/
├── api/
│   ├── server.js              # Entry point
│   ├── config/db.js           # Conexión PostgreSQL
│   ├── middleware/
│   │   ├── auth.js            # JWT validation
│   │   └── security.js        # Helmet, rate limit
│   ├── routes/
│   │   ├── auth.js            # Login, registro, admin login
│   │   ├── games.js           # Blackjack, Truco, Ludo, Jackpot
│   │   ├── cajas.js           # Caja Misteriosa (migrado)
│   │   ├── payments.js        # MercadoPago webhook
│   │   └── admin.js           # Panel admin API
│   └── db/schema.sql
├── public/
│   ├── index.html             # Login/Registro
│   ├── lobby.html             # Selector de juegos
│   ├── wallet.html            # Carga de fichas
│   └── games/                 # Páginas de cada juego
│       ├── blackjack.html
│       ├── truco.html
│       ├── ludo.html
│       ├── jackpot.html
│       └── cajas.html
├── admin/
│   └── index.html             # Panel admin unificado
├── .env.example
├── render.yaml                # Config deploy automático
└── package.json
```

## 💡 Notas de Seguridad
- Los JWT de usuarios y admin usan secrets diferentes
- Rate limiting en login (10 intentos / 15 min)
- Contraseñas con bcrypt salt 12
- Queries con parámetros preparados (anti SQL injection)
- Helmet configura headers HTTP seguros
- CORS restringido al dominio de producción
