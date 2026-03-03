// app.js (COMPLETO corregido)
// ✅ Cambios clave:
// 1) createdAt usa Timestamp.now() (evita fallos con rules "is timestamp")
// 2) El público NO lee legajos_activos (no rompe si rules bloquean lectura)
//    -> La validación “legajo existe” la hace Firestore Rules con exists()
//    -> Si falla, mostramos mensaje claro.
// 3) Normaliza C/c a "C#" (ya lo hacías)
// 4) Admin sigue pudiendo ABM + listar + exportar
// 5) Si no hay datos en el mes, muestra "No hay datos" y no queda colgado

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore,
  addDoc,
  collection,
  Timestamp, // ✅ IMPORTANTE
  query,
  where,
  orderBy,
  limit,
  getDocs,
  doc,
  setDoc,
  updateDoc,
  writeBatch,
  getCountFromServer,
  startAfter,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";


const COOLDOWN_SECONDS = 5;
let lastSubmitAt = 0;
let cooldownTimer = null;
const MAX_INPUT_LEN = 300;
const MAX_TOKENS_PER_SUBMIT = 50;
const MIN_C = 1;
const MAX_C = 99;

const PREVIEW_LIMIT = 50;        // vista previa al cargar mes
const EXPORT_PAGE_SIZE = 1000;   // paginado para export
const LEGAJOS_PAGE_SIZE = 5;

const $ = (id) => document.getElementById(id);

// ===== DOM =====
const frmIngreso = $("frmIngreso");
const inputTokens = $("tokens");
const btnIngreso = $("btnIngreso");
const btnLimpiar = $("btnLimpiar");
const msgPublic = $("msgPublic");
const preview = $("preview");

const frmAdminLogin = $("frmAdminLogin");
const adminEmail = $("adminEmail");
const adminPass = $("adminPass");
const btnAdminLogin = $("btnAdminLogin");
const btnAdminLogout = $("btnAdminLogout");
const msgAdmin = $("msgAdmin");

const adminPanelSection = $("adminPanelSection");
const mesInput = $("mes");
const btnCargarMes = $("btnCargarMes");
const btnExportarMes = $("btnExportarMes");
const mesInfo = $("mesInfo");
const tblBody = $("tbl")?.querySelector("tbody");

const nuevoLegajo = $("nuevoLegajo");
const nombreLegajo = $("nombreLegajo");
const btnAgregarLegajo = $("btnAgregarLegajo");
const btnCargarLegajos = $("btnCargarLegajos");
const msgLegajos = $("msgLegajos");
const tblLegajosBody = $("tblLegajos")?.querySelector("tbody");
const buscarLegajo = $("buscarLegajo");
const btnPrevLegajos = $("btnPrevLegajos");
const btnNextLegajos = $("btnNextLegajos");
const legajosPager = $("legajosPager");

const btnUnlockImport = $("btnUnlockImport");
const importBox = $("importBox");
const bulkLegajos = $("bulkLegajos");
const btnImportarLegajos = $("btnImportarLegajos");
const btnCancelarImport = $("btnCancelarImport");
const msgImport = $("msgImport");

// ===== Helpers UI =====
function setMsg(el, text, type) {
  if (!el) return;
  el.textContent = text || "";
  el.className = "msg " + (type || "");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatErr(err) {
  const code = err?.code ? `(${err.code}) ` : "";
  const msg = err?.message || String(err || "Error");
  return `${code}${msg}`;
}

// ===== Firebase init =====
if (!window.FIREBASE_CONFIG) {
  setMsg(msgPublic, "Falta firebase-config.js (window.FIREBASE_CONFIG).", "err");
  if (btnIngreso) btnIngreso.disabled = true;
  throw new Error("Missing FIREBASE_CONFIG");
}
const app = initializeApp(window.FIREBASE_CONFIG);
const db = getFirestore(app);
const auth = getAuth(app);

async function ensureAnon() {
  if (!auth.currentUser) await signInAnonymously(auth);
}

// ===== Parse / Validación tokens =====
const RE_CTOKEN = /^C([1-9]\d{0,1})$/i;

function canonicalizeLegajoDigits(d) {
  const s = String(d).replace(/^0+/, "");
  return s === "" ? "0" : s;
}

function canonicalizeCToken(tok) {
  const m = String(tok).trim().match(RE_CTOKEN);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < MIN_C || n > MAX_C) return null;
  return `C${n}`; // ✅ siempre mayúscula
}

function isValidLegajoCanon(canon) {
  if (canon === "0") return true;
  if (!/^[1-9]\d{0,3}$/.test(canon)) return false;
  const n = Number(canon);
  return Number.isInteger(n) && n >= 1 && n <= 9999;
}

function parseTokens(raw) {
  const tokens = String(raw || "")
    .slice(0, MAX_INPUT_LEN)
    .split(/[,\s;\t\r\n]+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const ok = [];
  const bad = [];

  for (const t of tokens) {
    // C#
    const cTok = canonicalizeCToken(t);
    if (cTok) {
      if (!seen.has(cTok)) {
        seen.add(cTok);
        ok.push(cTok);
      }
      continue;
    }

    // Legajo numérico (solo dígitos)
    const onlyDigits = t.replace(/\D/g, "");
    if (!onlyDigits || onlyDigits.length > 4) {
      bad.push(t);
      continue;
    }

    const canon = canonicalizeLegajoDigits(onlyDigits);
    if (!isValidLegajoCanon(canon)) {
      bad.push(t);
      continue;
    }

    if (!seen.has(canon)) {
      seen.add(canon);
      ok.push(canon);
    }
  }

  return { ok, bad };
}

function refreshPreview() {
  if (!preview) return;
  const { ok, bad } = parseTokens(inputTokens?.value);
  preview.textContent =
    `OK (${ok.length}): ${ok.join(", ")}\n` +
    (bad.length ? `\nINVALIDOS (${bad.length}): ${bad.join(", ")}` : "");
}

inputTokens?.addEventListener("input", refreshPreview);

btnLimpiar?.addEventListener("click", () => {
  if (!inputTokens) return;
  inputTokens.value = "";
  refreshPreview();
  setMsg(msgPublic, "", "");
  inputTokens.focus();
});

// ===== Guardar ingreso (1 doc por token) =====
frmIngreso?.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg(msgPublic, "", "");

  const now = Date.now();
  const diff = (now - lastSubmitAt) / 1000;

  // 🚫 Cooldown activo
  if (diff < COOLDOWN_SECONDS) {
    const remaining = Math.ceil(COOLDOWN_SECONDS - diff);
    return setMsg(
      msgPublic,
      `Esperá ${remaining}s antes de volver a enviar.`,
      "err"
    );
  }

  if (btnIngreso) btnIngreso.disabled = true;

  try {
    await ensureAnon();

    const raw = inputTokens?.value || "";
    const { ok, bad } = parseTokens(raw);

    if (!ok.length) {
      btnIngreso.disabled = false;
      return setMsg(msgPublic, "No hay legajos válidos.", "err");
    }

    if (bad.length) {
      btnIngreso.disabled = false;
      return setMsg(msgPublic, `Tokens inválidos: ${bad.join(", ")}`, "err");
    }

    if (ok.length > MAX_TOKENS_PER_SUBMIT) {
      btnIngreso.disabled = false;
      return setMsg(
        msgPublic,
        `Máximo ${MAX_TOKENS_PER_SUBMIT} tokens por envío.`,
        "err"
      );
    }

    const uid = auth.currentUser?.uid || "anon";

    const writes = ok.map((t) => {
      const isC = /^C\d+$/.test(t);
      const cantidadC = isC ? Number(t.slice(1)) : 0;

      return addDoc(collection(db, "registros_tokens"), {
        createdAt: Timestamp.now(),
        token: t,
        tipo: isC ? "C" : "LEGAJO",
        cantidadC,
        raw,
        uid,
      });
    });

    await Promise.all(writes);

    // ✅ Se guarda el momento del último envío
    lastSubmitAt = Date.now();

    // ⏳ Inicia contador visual opcional
    startCooldownCountdown();

    setMsg(msgPublic, `OK guardado (${ok.length}).`, "ok");

    if (inputTokens) {
      inputTokens.value = "";
      refreshPreview();
      inputTokens.focus();
    }
  } catch (err) {
    console.error(err);

    if (err?.code === "permission-denied") {
      setMsg(
        msgPublic,
        "No permitido: puede ser legajo inexistente/no activo o token inválido.",
        "err"
      );
    } else {
      setMsg(msgPublic, `Error guardando:\n${formatErr(err)}`, "err");
    }
  } finally {
    if (btnIngreso) btnIngreso.disabled = false;
  }
});

function startCooldownCountdown() {
  if (!btnIngreso) return;

  let remaining = COOLDOWN_SECONDS;
  btnIngreso.disabled = true;
  btnIngreso.textContent = `Esperar ${remaining}s`;

  if (cooldownTimer) clearInterval(cooldownTimer);

  cooldownTimer = setInterval(() => {
    remaining--;

    if (remaining <= 0) {
      clearInterval(cooldownTimer);
      btnIngreso.disabled = false;
      btnIngreso.textContent = "Ingreso";
      return;
    }

    btnIngreso.textContent = `Esperar ${remaining}s`;
  }, 1000);
}

// ===== Admin Auth =====
frmAdminLogin?.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg(msgAdmin, "", "");

  try {
    if (btnAdminLogin) btnAdminLogin.disabled = true;
    await signInWithEmailAndPassword(auth, adminEmail.value.trim(), adminPass.value);
    setMsg(msgAdmin, "OK. Logueado.", "ok");
  } catch (err) {
    console.error(err);
    setMsg(msgAdmin, `Login falló:\n${formatErr(err)}`, "err");
  } finally {
    if (btnAdminLogin) btnAdminLogin.disabled = false;
  }
});

btnAdminLogout?.addEventListener("click", async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  const isPasswordUser = !!user?.providerData?.some((p) => p.providerId === "password");
  if (adminPanelSection) adminPanelSection.style.display = isPasswordUser ? "block" : "none";
  if (btnAdminLogout) btnAdminLogout.style.display = user ? "inline-block" : "none";

  if (!user) {
    try {
      await ensureAnon();
    } catch {}
  }
});

// ===== Mes: preview + export =====
setMesActual();

function setMesActual() {
  if (!mesInput) return;
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  mesInput.value = `${d.getFullYear()}-${mm}`;
}

function getMonthRange(yyyyMm) {
  const [y, m] = yyyyMm.split("-").map(Number);
  const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const end = new Date(y, m, 1, 0, 0, 0, 0);
  return { start, end };
}

function formatFechaHoraMin(dateObj) {
  return dateObj.toLocaleString("es-AR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function clearMonthTable() {
  if (tblBody) tblBody.innerHTML = "";
  if (mesInfo) mesInfo.textContent = "";
}

async function getMonthCount(start, end) {
  const qCount = query(
    collection(db, "registros_tokens"),
    where("createdAt", ">=", start),
    where("createdAt", "<", end)
  );
  const snap = await getCountFromServer(qCount);
  return snap.data().count || 0;
}

async function loadMonthPreview(yyyyMm) {
  const { start, end } = getMonthRange(yyyyMm);
  const total = await getMonthCount(start, end);

  const qPrev = query(
    collection(db, "registros_tokens"),
    where("createdAt", ">=", start),
    where("createdAt", "<", end),
    orderBy("createdAt", "asc"),
    limit(PREVIEW_LIMIT)
  );

  const snap = await getDocs(qPrev);

  const rows = [];
  snap.forEach((docu) => {
    const d = docu.data();
    const createdAt = d.createdAt?.toDate ? d.createdAt.toDate() : null;
    rows.push({
      FechaHora: createdAt ? formatFechaHoraMin(createdAt) : "",
      Legajo: d.token ?? "",
    });
  });

  return { total, rows };
}

btnCargarMes?.addEventListener("click", async () => {
  setMsg(msgAdmin, "", "");
  clearMonthTable();

  try {
    const yyyyMm = mesInput?.value;
    if (!yyyyMm) return setMsg(msgAdmin, "Elegí un mes.", "err");

    if (btnCargarMes) btnCargarMes.disabled = true;

    const { total, rows } = await loadMonthPreview(yyyyMm);

    if (mesInfo) {
      mesInfo.textContent = `Total del mes: ${total}. Mostrando vista previa: ${Math.min(
        PREVIEW_LIMIT,
        total
      )}.`;
    }

    if (tblBody) {
      for (const r of rows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${escapeHtml(r.FechaHora)}</td><td>${escapeHtml(r.Legajo)}</td>`;
        tblBody.appendChild(tr);
      }
    }

    setMsg(msgAdmin, "OK.", "ok");
  } catch (err) {
    console.error(err);
    setMsg(msgAdmin, `Error cargando mes:\n${formatErr(err)}`, "err");
  } finally {
    if (btnCargarMes) btnCargarMes.disabled = false;
  }
});

async function exportMonthToExcel(yyyyMm) {
  const { start, end } = getMonthRange(yyyyMm);

  let allRows = [];
  let lastDoc = null;
  let fetched = 0;

  while (true) {
    const base = [
      collection(db, "registros_tokens"),
      where("createdAt", ">=", start),
      where("createdAt", "<", end),
      orderBy("createdAt", "asc"),
      limit(EXPORT_PAGE_SIZE),
    ];

    const qPage = lastDoc ? query(...base, startAfter(lastDoc)) : query(...base);

    const snap = await getDocs(qPage);
    if (snap.empty) break;

    snap.forEach((docu) => {
      const d = docu.data();
      const createdAt = d.createdAt?.toDate ? d.createdAt.toDate() : null;
      allRows.push({
        FechaHora: createdAt ? formatFechaHoraMin(createdAt) : "",
        Legajo: d.token ?? "",
      });
    });

    fetched += snap.size;
    lastDoc = snap.docs[snap.docs.length - 1];

    if (mesInfo) mesInfo.textContent = `Exportando... ${fetched} filas leídas`;
    if (snap.size < EXPORT_PAGE_SIZE) break;
  }

  if (!allRows.length) return { filename: null, rows: 0 };

  const ws = XLSX.utils.json_to_sheet(allRows, { header: ["FechaHora", "Legajo"] });
  ws["!cols"] = [{ wch: 20 }, { wch: 12 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Registros");

  const filename = `control_colectivos_${yyyyMm}.xlsx`;
  XLSX.writeFile(wb, filename, { compression: true });

  return { filename, rows: allRows.length };
}

btnExportarMes?.addEventListener("click", async () => {
  setMsg(msgAdmin, "", "");

  try {
    const yyyyMm = mesInput?.value;
    if (!yyyyMm) return setMsg(msgAdmin, "Elegí un mes.", "err");

    if (btnExportarMes) btnExportarMes.disabled = true;
    if (mesInfo) mesInfo.textContent = "Preparando exportación...";

    // ✅ chequeo rápido
    const { start, end } = getMonthRange(yyyyMm);
    const total = await getMonthCount(start, end);

    if (!total || total === 0) {
      if (mesInfo) mesInfo.textContent = "";
      return setMsg(msgAdmin, "No hay datos para ese mes.", "err");
    }

    if (mesInfo) mesInfo.textContent = `Exportando... (total estimado: ${total})`;

    const res = await exportMonthToExcel(yyyyMm);

    if (!res.filename || res.rows === 0) {
      if (mesInfo) mesInfo.textContent = "";
      return setMsg(msgAdmin, "No hay datos para ese mes.", "err");
    }

    if (mesInfo) mesInfo.textContent = `Exportado: ${res.filename} (${res.rows} filas)`;
    setMsg(msgAdmin, "OK.", "ok");
  } catch (err) {
    console.error(err);
    if (mesInfo) mesInfo.textContent = "";
    setMsg(msgAdmin, `Error exportando:\n${formatErr(err)}`, "err");
  } finally {
    if (btnExportarMes) btnExportarMes.disabled = false;
  }
});

// ===== ABM Legajos (buscador + paginación) =====
let legajosCache = [];
let pageIndex = 0;

function renderLegajos() {
  if (!tblLegajosBody) return;

  const qText = String(buscarLegajo?.value || "").trim().toLowerCase();

  let filtered = legajosCache;
  if (qText) {
    filtered = legajosCache.filter(
      (x) => String(x.leg).includes(qText) || String(x.nombre || "").toLowerCase().includes(qText)
    );
  }

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / LEGAJOS_PAGE_SIZE));

  if (pageIndex >= totalPages) pageIndex = totalPages - 1;
  if (pageIndex < 0) pageIndex = 0;

  const start = pageIndex * LEGAJOS_PAGE_SIZE;
  const slice = filtered.slice(start, start + LEGAJOS_PAGE_SIZE);

  if (legajosPager) {
    legajosPager.textContent = total
      ? `Mostrando ${start + 1}-${Math.min(start + LEGAJOS_PAGE_SIZE, total)} de ${total} (página ${
          pageIndex + 1
        }/${totalPages})`
      : `Sin resultados`;
  }

  if (btnPrevLegajos) btnPrevLegajos.disabled = pageIndex === 0;
  if (btnNextLegajos) btnNextLegajos.disabled = pageIndex >= totalPages - 1;

  tblLegajosBody.innerHTML = "";

  for (const x of slice) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(x.leg)}</td>
      <td>${escapeHtml(x.nombre || "")}</td>
      <td>${x.activo ? "Sí" : "No"}</td>
      <td>
        <button data-leg="${escapeHtml(x.leg)}" class="secondary btnToggleActivo">
          ${x.activo ? "Desactivar" : "Activar"}
        </button>
      </td>
    `;
    tblLegajosBody.appendChild(tr);
  }

  tblLegajosBody.querySelectorAll(".btnToggleActivo").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const leg = btn.getAttribute("data-leg");
      if (!leg) return;

      try {
        const current = legajosCache.find((x) => x.leg === leg);
        const nextActivo = !(current?.activo);

        await updateDoc(doc(db, "legajos_activos", leg), {
          activo: nextActivo,
          updatedAt: Timestamp.now(), // ✅ timestamp real
        });

        if (current) current.activo = nextActivo;

        setMsg(msgLegajos, `OK. Legajo ${leg} ${nextActivo ? "activado" : "desactivado"}.`, "ok");
        renderLegajos();
      } catch (err) {
        console.error(err);
        setMsg(msgLegajos, `No pude actualizar:\n${formatErr(err)}`, "err");
      }
    });
  });
}

function canonLegajoFromInput(v) {
  const onlyDigits = String(v || "").replace(/\D/g, "");
  if (!onlyDigits || onlyDigits.length > 4) return null;
  const canon = canonicalizeLegajoDigits(onlyDigits);
  if (!isValidLegajoCanon(canon)) return null;
  return canon;
}

btnAgregarLegajo?.addEventListener("click", async () => {
  setMsg(msgLegajos, "", "");

  try {
    const canon = canonLegajoFromInput(nuevoLegajo?.value);
    if (!canon) return setMsg(msgLegajos, "Legajo inválido (0..9999).", "err");
    if (canon === "0") return setMsg(msgLegajos, "El legajo 0 no se administra (siempre permitido).", "err");

    const nombre = String(nombreLegajo?.value || "").trim().slice(0, 60);

    await setDoc(
      doc(db, "legajos_activos", canon),
      {
        activo: true,
        nombre,
        updatedAt: Timestamp.now(), // ✅ timestamp real
      },
      { merge: true }
    );

    setMsg(msgLegajos, `OK. Legajo ${canon} activado.`, "ok");
    if (nuevoLegajo) nuevoLegajo.value = "";
    if (nombreLegajo) nombreLegajo.value = "";
  } catch (err) {
    console.error(err);
    setMsg(msgLegajos, `Error:\n${formatErr(err)}`, "err");
  }
});

btnCargarLegajos?.addEventListener("click", async () => {
  setMsg(msgLegajos, "", "");
  if (tblLegajosBody) tblLegajosBody.innerHTML = "";
  legajosCache = [];
  pageIndex = 0;

  try {
    const qLeg = query(collection(db, "legajos_activos"), orderBy("activo", "desc"), limit(5000));
    const snap = await getDocs(qLeg);

    snap.forEach((d) => {
      const data = d.data();
      legajosCache.push({
        leg: d.id,
        nombre: data.nombre ?? "",
        activo: !!data.activo,
      });
    });

    renderLegajos();
    setMsg(msgLegajos, "Listado cargado.", "ok");
  } catch (err) {
    console.error(err);
    setMsg(msgLegajos, `Error cargando:\n${formatErr(err)}`, "err");
  }
});

buscarLegajo?.addEventListener("input", () => {
  pageIndex = 0;
  renderLegajos();
});
btnPrevLegajos?.addEventListener("click", () => {
  pageIndex--;
  renderLegajos();
});
btnNextLegajos?.addEventListener("click", () => {
  pageIndex++;
  renderLegajos();
});

// ===== Importación masiva (10 clics, sin mensajes “faltan X”) =====
let unlockClicks = 0;
let importUnlocked = false;

btnUnlockImport?.addEventListener("click", () => {
  unlockClicks++;
  if (unlockClicks >= 10) {
    importUnlocked = true;
    if (importBox) importBox.style.display = "block";
  }
});

btnCancelarImport?.addEventListener("click", () => {
  importUnlocked = false;
  unlockClicks = 0;
  if (importBox) importBox.style.display = "none";
  if (bulkLegajos) bulkLegajos.value = "";
  setMsg(msgImport, "", "");
});

function parseLegajosFromBulk(text) {
  const parts = String(text || "")
    .split(/[,\s;\t\r\n]+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const ok = [];
  const invalid = [];

  for (const p of parts) {
    const digits = p.replace(/\D/g, "");
    if (!digits || digits.length > 4) {
      invalid.push(p);
      continue;
    }
    const canon = canonicalizeLegajoDigits(digits);
    if (!isValidLegajoCanon(canon)) {
      invalid.push(p);
      continue;
    }
    if (!seen.has(canon)) {
      seen.add(canon);
      ok.push(canon);
    }
  }
  return { ok, invalid };
}

function requireAdminOrThrow() {
  const u = auth.currentUser;
  const isPasswordUser = !!u?.providerData?.some((p) => p.providerId === "password");
  if (!u || !isPasswordUser) throw new Error("Solo admin logueado puede importar.");
}

btnImportarLegajos?.addEventListener("click", async () => {
  setMsg(msgImport, "", "");

  try {
    requireAdminOrThrow();
    if (!importUnlocked) return;

    const { ok, invalid } = parseLegajosFromBulk(bulkLegajos?.value);
    if (!ok.length) return setMsg(msgImport, "No encontré legajos válidos.", "err");

    if (!confirm(`Se activarán ${ok.length} legajos. ¿Continuar?`)) return;

    if (btnImportarLegajos) btnImportarLegajos.disabled = true;

    let imported = 0;
    for (let i = 0; i < ok.length; i += 450) {
      const slice = ok.slice(i, i + 450);
      const batch = writeBatch(db);

      for (const leg of slice) {
        if (leg === "0") continue;
        batch.set(
          doc(db, "legajos_activos", leg),
          {
            activo: true,
            updatedAt: Timestamp.now(), // ✅ timestamp real
          },
          { merge: true }
        );
        imported++;
      }

      await batch.commit();
    }

    setMsg(
      msgImport,
      `OK importados/activados: ${imported}` +
        (invalid.length
          ? `\nInválidos ignorados: ${invalid.slice(0, 10).join(", ")}${invalid.length > 10 ? "..." : ""}`
          : ""),
      "ok"
    );

    // bloquea de nuevo
    importUnlocked = false;
    unlockClicks = 0;
    if (importBox) importBox.style.display = "none";
    if (bulkLegajos) bulkLegajos.value = "";
  } catch (err) {
    console.error(err);
    setMsg(msgImport, `Error:\n${formatErr(err)}`, "err");
  } finally {
    if (btnImportarLegajos) btnImportarLegajos.disabled = false;
  }
});

// ===== Init =====
(async function init() {
  try {
    await ensureAnon();
  } catch {}
  refreshPreview();
})();
