// ── NAV SCROLL ──
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 40));

// ── MOBILE MENU ──
const mobileMenu = document.createElement('div');
mobileMenu.className = 'nav__mobile';
mobileMenu.innerHTML = `
  <button class="nav__mobile-close" id="menuClose">&#215;</button>
  <a href="#about"    class="mobile-link">Про нас</a>
  <a href="#services" class="mobile-link">Послуги</a>
  <a href="#cases"    class="mobile-link">Кейси</a>
  <a href="#team"     class="mobile-link">Команда</a>
  <a href="#contact"  class="mobile-link">Консультація</a>
`;
document.body.appendChild(mobileMenu);
document.getElementById('burger').addEventListener('click', () => mobileMenu.classList.add('open'));
document.getElementById('menuClose').addEventListener('click', () => mobileMenu.classList.remove('open'));
mobileMenu.querySelectorAll('.mobile-link').forEach(l =>
  l.addEventListener('click', () => mobileMenu.classList.remove('open'))
);

// ── AOS ──
if (typeof AOS !== 'undefined') {
  AOS.init({ duration: 800, once: true, offset: 60, easing: 'ease-out-cubic' });
}

// ── FAQ ──
function toggleFaq(el) {
  const item    = el.parentElement;
  const wasOpen = item.classList.contains('open');
  document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
  if (!wasOpen) item.classList.add('open');
}

// ── CONTACT FORM ──
document.getElementById('contactForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  const ok  = document.getElementById('formSuccess');
  const err = document.getElementById('formError');
  const f   = e.target;
  ok.style.display = err.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Надсилання...';
  try {
    const res = await fetch('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:    f.name.value.trim(),
        phone:   f.phone.value.trim(),
        message: f.message.value.trim(),
      }),
    });
    (res.ok ? ok : err).style.display = 'block';
    if (res.ok) f.reset();
  } catch {
    err.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Надіслати заявку';
  }
});

// ── LIGHTBOX (одиночне фото) ──
const lightbox    = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');

function openAboutPhoto(url, alt) {
  lightboxImg.src = url;
  lightboxImg.alt = alt || '';
  lightbox.classList.add('open');
  lightbox.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  lightbox.classList.remove('open');
  lightbox.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

if (lightbox) {
  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  document.getElementById('lightboxBackdrop').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', e => {
    if (lightbox.classList.contains('open') && e.key === 'Escape') closeLightbox();
  });
}

// ── ABOUT PHOTOS ──
let aboutPhotos = [];

async function loadAboutPhotos() {
  try {
    const { photos } = await fetch('/api/about-photos').then(r => r.json());
    aboutPhotos = [1, 2, 3, 4].map(i => photos[String(i)]).filter(Boolean);
  } catch {}
  renderAboutPhotos();
}

function renderAboutPhotos() {
  const container = document.getElementById('aboutPhotos');
  if (!container) return;
  const ph = [
    { icon: '⚖', label: 'Захист у суді' },
    { icon: '🏛', label: 'Юридичний офіс' },
    { icon: '📋', label: 'Документи' },
    { icon: '🤝', label: 'Партнерство' },
  ];
  container.innerHTML = Array.from({ length: 4 }, (_, i) => {
    const p = aboutPhotos[i];
    return p
      ? `<div class="about-photo about-photo--click" tabindex="0" role="button">
           <img src="${p.url}" alt="Фото ${i + 1}" loading="lazy">
         </div>`
      : `<div class="about-photo about-photo--empty">
           <span class="ph-icon">${ph[i].icon}</span>
           <span class="ph-label">${ph[i].label}</span>
         </div>`;
  }).join('');
  container.querySelectorAll('.about-photo--click').forEach((el, i) => {
    const url = aboutPhotos[i]?.url;
    el.addEventListener('click', () => openAboutPhoto(url, `Фото ${i + 1}`));
    el.addEventListener('keydown', e => (e.key === 'Enter' || e.key === ' ') && openAboutPhoto(url, `Фото ${i + 1}`));
  });
}

// ── TEAM ──
async function loadTeam() {
  try {
    const { team } = await fetch('/api/team').then(r => r.json());
    renderTeam(team);
  } catch {}
}

function renderTeam(team) {
  const grid = document.getElementById('teamGrid');
  if (!grid) return;
  grid.innerHTML = team.map((m, i) => `
    <div class="team-card" data-aos="fade-up" data-aos-delay="${i * 80}">
      <div class="team-card__photo">
        ${m.photoUrl
          ? `<img src="${m.photoUrl}" alt="${m.name}">`
          : `<div class="team-card__initials">${m.initials}</div>`}
      </div>
      <h3>${m.name}</h3>
      <div class="team-card__role">${m.role}</div>
      <p>${m.bio}</p>
    </div>
  `).join('');
}

// ── CASE PHOTOS ──
async function loadCasePhotos() {
  try {
    const { photos } = await fetch('/api/case-photos').then(r => r.json());
    Object.values(photos).forEach(p => {
      const el = document.getElementById(`caseImg${p.slot}`);
      if (el) {
        el.innerHTML = `<img src="${p.url}" alt="Кейс ${p.slot}">`;
        el.classList.add('loaded');
      }
    });
  } catch {}
}

loadAboutPhotos();
loadTeam();
loadCasePhotos();
