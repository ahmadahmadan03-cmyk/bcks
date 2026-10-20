import { createClient } from '@libsql/client/web';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4.5mb',
    },
  },
};

// ... kode lainnya ke bawah tetap sama ...
async function uploadToDrive(base64Data, filename, isFoto) {
    const gasUrl = process.env.GAS_UPLOAD_URL;
    if (!gasUrl) throw new Error("GAS_UPLOAD_URL belum disetting di Vercel Environment Variables.");
    
    try {
        const response = await fetch(gasUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base64: base64Data, filename: filename, isFoto: isFoto })
        });
        
        // Membaca text terlebih dahulu untuk mengantisipasi Google Script error/timeout
        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error("Koneksi ke Google Drive bermasalah atau terputus. Respons: " + text.substring(0, 50));
        }
        
        if (data.status !== "success") throw new Error("Gagal upload ke Google Drive: " + data.message);
        return data.url;
    } catch (err) {
        throw new Error("Gagal menghubungi server Google: " + err.message);
    }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const dbUrl = process.env.TURSO_DATABASE_URL;
    const dbToken = process.env.TURSO_AUTH_TOKEN;

    if (!dbUrl || !dbToken) {
      throw new Error("Kredensial Database gagal dimuat. Pastikan TURSO_DATABASE_URL dan TURSO_AUTH_TOKEN sudah disetting di Vercel.");
    }

    const db = createClient({ url: dbUrl, authToken: dbToken, intMode: 'bigint' });
    const { action, args } = req.body;
    let result;

    try { await db.execute("ALTER TABLE users ADD COLUMN skor_kepribadian TEXT"); } catch(e){}
    try { await db.execute("ALTER TABLE users ADD COLUMN skor_profesional TEXT"); } catch(e){}
    try { await db.execute("ALTER TABLE users ADD COLUMN skor_sosial TEXT"); } catch(e){}
    try { await db.execute("ALTER TABLE users ADD COLUMN skor_total TEXT"); } catch(e){}
    try { await db.execute("ALTER TABLE users ADD COLUMN status_lulus_cat TEXT"); } catch(e){}
    try { await db.execute("ALTER TABLE biodata ADD COLUMN manajerial TEXT"); } catch(e){}
    try { await db.execute("ALTER TABLE biodata ADD COLUMN ruangan_ujian TEXT"); } catch(e){}

    // =====================================================================
    // PERBAIKAN: Middleware Pengecekan Akses Global Khusus Endpoint Peserta
    // =====================================================================
    const endpointPeserta = ['getBiodataPegawai', 'saveBiodata', 'getHasilCATPegawai', 'uploadSingleFile'];
    
    if (endpointPeserta.includes(action)) {
        const { rows: rAkses } = await db.execute("SELECT kunci, nilai FROM pengaturan WHERE kunci IN ('Akses_Login_Peserta', 'Pesan_Tutup_Akses')");
        let isClosed = false;
        let closeMsg = "Akses login ditutup oleh Panitia.";
        
        rAkses.forEach(row => {
            if (row.kunci === 'Akses_Login_Peserta' && row.nilai === 'false') isClosed = true;
            if (row.kunci === 'Pesan_Tutup_Akses' && row.nilai) closeMsg = row.nilai;
        });

        // Jika akses ditutup, kembalikan respons error khusus untuk mengunci frontend
        if (isClosed) {
            return res.status(200).json({ error_akses: closeMsg });
        }
    }
    // =====================================================================

switch (action) {
      // 1. PERBAIKAN: Update logika loginUser untuk mengecek akses
case 'loginUser':
        const nip = args[0]; const pass = args[1];
        
        // Bypass untuk akun super admin default
        if (nip.toLowerCase() === 'admin' && pass.toLowerCase() === 'admin') {
            result = { status: "success", role: "Admin", nip: "admin", nama: "Administrator Sistem" };
            break;
        }

        // 1. Cek kredensial di database terlebih dahulu untuk mengetahui role (Admin/Pegawai)
        const { rows: users } = await db.execute({ sql: "SELECT * FROM users WHERE nip = ? AND nik = ?", args: [nip, pass] });
        
        if (users.length === 0) {
            result = { status: "error", message: "NIP atau Password salah!" };
            break;
        }

        const user = users[0];

        // 2. Jika yang masuk adalah Peserta (Pegawai), cek status penutupan akses
        if (user.role !== 'Admin') {
            const { rows: rAkses } = await db.execute("SELECT kunci, nilai FROM pengaturan WHERE kunci IN ('Akses_Login_Peserta', 'Pesan_Tutup_Akses')");
            let isClosed = false;
            let closeMsg = "Akses login ditutup oleh Panitia.";
            
            rAkses.forEach(row => {
                if (row.kunci === 'Akses_Login_Peserta' && row.nilai === 'false') isClosed = true;
                if (row.kunci === 'Pesan_Tutup_Akses' && row.nilai) closeMsg = row.nilai;
            });

            // Jika akses ditutup, tolak proses login untuk peserta
            if (isClosed) {
                result = { status: "error", message: closeMsg };
                break;
            }
        }

        // 3. Jika berhasil melewati pengecekan di atas (atau jika role-nya Admin), izinkan masuk
        result = { status: "success", role: user.role, nip: user.nip, nama: user.nama };
        break;
      // 2. PERBAIKAN: Menarik data akses login ke Frontend
      case 'getPengaturanGlobal':
        const { rows: rPeng } = await db.execute("SELECT * FROM pengaturan");
        const { rows: rPengumuman } = await db.execute("SELECT * FROM pengumuman ORDER BY rowid DESC");
        
        let configData = { Batas_Waktu: "", PengumumanList: [], Buka_Pengumuman_CAT: "false", Akses_Login: "true", Pesan_Tutup: "" };
        rPeng.forEach(row => {
           if(row.kunci === "Batas_Waktu" && row.nilai) configData.Batas_Waktu = new Date(row.nilai).toISOString();
           if(row.kunci === "Buka_Pengumuman_CAT" && row.nilai) configData.Buka_Pengumuman_CAT = row.nilai;
           if(row.kunci === "Akses_Login_Peserta" && row.nilai) configData.Akses_Login = row.nilai;
           if(row.kunci === "Pesan_Tutup_Akses" && row.nilai) configData.Pesan_Tutup = row.nilai;
        });
        rPengumuman.forEach(p => configData.PengumumanList.push({ row: p.id, id: p.id, tanggal: p.tanggal, judul: p.judul, teks: p.teks, file: p.file_url }));
        result = configData;
        break;

      // 3. TAMBAHKAN: Action baru untuk menyimpan pengaturan Buka/Tutup akses
      case 'savePengaturanAkses':
        let statusAkses = args[0]; 
        let pesanTutup = args[1];

        // Simpan Status Buka/Tutup (true/false)
        let cAkses = await db.execute("SELECT * FROM pengaturan WHERE kunci = 'Akses_Login_Peserta'");
        if (cAkses.rows.length > 0) await db.execute({ sql: "UPDATE pengaturan SET nilai = ? WHERE kunci = 'Akses_Login_Peserta'", args: [statusAkses] });
        else await db.execute({ sql: "INSERT INTO pengaturan (kunci, nilai) VALUES ('Akses_Login_Peserta', ?)", args: [statusAkses] });

        // Simpan Pesan Alasan Penutupan
        let cPesan = await db.execute("SELECT * FROM pengaturan WHERE kunci = 'Pesan_Tutup_Akses'");
        if (cPesan.rows.length > 0) await db.execute({ sql: "UPDATE pengaturan SET nilai = ? WHERE kunci = 'Pesan_Tutup_Akses'", args: [pesanTutup] });
        else await db.execute({ sql: "INSERT INTO pengaturan (kunci, nilai) VALUES ('Pesan_Tutup_Akses', ?)", args: [pesanTutup] });

        result = "Pengaturan akses login berhasil disimpan!";
        break;

      // ... (Action saveBatasWaktu dan lain-lain di bawah ini biarkan sama / jangan diubah)
      case 'saveBatasWaktu':
        const cekBatas = await db.execute("SELECT * FROM pengaturan WHERE kunci = 'Batas_Waktu'");
        if (cekBatas.rows.length > 0) await db.execute({ sql: "UPDATE pengaturan SET nilai = ? WHERE kunci = 'Batas_Waktu'", args: [args[0]] });
        else await db.execute({ sql: "INSERT INTO pengaturan (kunci, nilai) VALUES ('Batas_Waktu', ?)", args: [args[0]] });
        result = "Pengaturan batas waktu berhasil disimpan!";
        break;

      case 'togglePengumumanCAT':
        const cekToggle = await db.execute("SELECT * FROM pengaturan WHERE kunci = 'Buka_Pengumuman_CAT'");
        if (cekToggle.rows.length > 0) await db.execute({ sql: "UPDATE pengaturan SET nilai = ? WHERE kunci = 'Buka_Pengumuman_CAT'", args: [args[0]] });
        else await db.execute({ sql: "INSERT INTO pengaturan (kunci, nilai) VALUES ('Buka_Pengumuman_CAT', ?)", args: [args[0]] });
        result = "Status tayang pengumuman CAT berhasil diubah!";
        break;

      case 'savePengumuman':
        let [pId, pJudul, pTeks, pFileObj, pOldFile, pActionRow] = args;
        let pFileUrl = pOldFile || "";
        if (pFileObj && pFileObj.base64) pFileUrl = await uploadToDrive(pFileObj.base64, `Pengumuman_${new Date().getTime()}_${pFileObj.name}`, false);
        let tglSkrg = new Date().toLocaleDateString('id-ID', {day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute:'2-digit'}) + " WIB";
        if (pActionRow && pActionRow !== "null" && pActionRow !== "") await db.execute({ sql: "UPDATE pengumuman SET judul=?, teks=?, file_url=? WHERE id=?", args: [pJudul, pTeks, pFileUrl, pActionRow] });
        else await db.execute({ sql: "INSERT INTO pengumuman (id, tanggal, judul, teks, file_url) VALUES (?, ?, ?, ?, ?)", args: ["PENG-" + new Date().getTime(), tglSkrg, pJudul, pTeks, pFileUrl] });
        result = "Pengumuman berhasil disimpan!";
        break;

      case 'deletePengumuman':
        await db.execute({ sql: "DELETE FROM pengumuman WHERE id=?", args: [args[0]] });
        result = "Pengumuman berhasil dihapus!";
        break;

      case 'getSemuaUsers':
        const { rows: rUsers } = await db.execute("SELECT * FROM users");
        result = rUsers.map(u => ({ 
            row: u.nip, role: u.role, nip: u.nip, nik: u.nik, nama: u.nama, 
            skor_kepribadian: u.skor_kepribadian || '', skor_profesional: u.skor_profesional || '', 
            skor_sosial: u.skor_sosial || '', skor_total: u.skor_total || '', status_lulus_cat: u.status_lulus_cat || '' 
        }));
        break;
      
      case 'addUserDB':
        await db.execute({ sql: "INSERT INTO users (role, nip, nik, nama) VALUES ('Pegawai', ?, ?, ?)", args: [args[0], args[1], args[2]] });
        result = "User berhasil ditambahkan";
        break;

      case 'editUserDB':
        await db.execute({ sql: "UPDATE users SET nip=?, nik=?, nama=? WHERE nip=?", args: [args[1], args[2], args[3], args[0]] });
        result = "Data User berhasil diupdate";
        break;

      case 'deleteUserDB':
        await db.execute({ sql: "DELETE FROM users WHERE nip=?", args: [args[0]] });
        result = "User berhasil dihapus";
        break;

      case 'uploadTemplateUsersExcel':
        let excelData = args[0]; let countUser = 0;
        for (let row of excelData) {
            if (row && row.length >= 3 && row[0]) {
                let uNip = row[0].toString().trim(); let uNik = row[1].toString().trim(); let uNama = row[2].toString().trim();
                let cekUser = await db.execute({ sql: "SELECT nip FROM users WHERE nip=?", args: [uNip] });
                if(cekUser.rows.length > 0) await db.execute({ sql: "UPDATE users SET nik=?, nama=?, role='Pegawai' WHERE nip=?", args: [uNik, uNama, uNip] });
                else await db.execute({ sql: "INSERT INTO users (role, nip, nik, nama) VALUES ('Pegawai', ?, ?, ?)", args: [uNip, uNik, uNama] });
                countUser++;
            }
        }
        result = countUser + " User berhasil diimpor ke database.";
        break;

      case 'uploadExcelNilaiCAT':
        let excelNilai = args[0]; let countNilai = 0;
        for (let row of excelNilai) {
            if (row && row.length >= 1 && row[0]) {
                let uNip = String(row[0]).trim();
                let kep = row[1] ? String(row[1]).trim() : '0';
                let prof = row[2] ? String(row[2]).trim() : '0';
                let sos = row[3] ? String(row[3]).trim() : '0';
                let tot = row[4] ? String(row[4]).trim() : '0';
                
                await db.execute({ 
                    sql: "UPDATE users SET skor_kepribadian=?, skor_profesional=?, skor_sosial=?, skor_total=? WHERE nip=?", 
                    args: [kep, prof, sos, tot, uNip] 
                });
                countNilai++;
            }
        }
        result = countNilai + " Data nilai peserta berhasil diimpor.";
        break;

      case 'setLulusCATMassal':
        let nipsLulus = args[0]; let statusLulus = args[1];
        for (let n of nipsLulus) {
            await db.execute({ sql: "UPDATE users SET status_lulus_cat=? WHERE nip=?", args: [statusLulus, n] });
        }
        result = `Berhasil update status ${statusLulus} untuk ${nipsLulus.length} peserta.`;
        break;

      case 'getSemuaBiodata':
      case 'getBiodataPegawai':
        const isSingle = action === 'getBiodataPegawai';
        let queryBio = isSingle ? { sql: "SELECT * FROM biodata WHERE nip=?", args: [args[0]] } : "SELECT * FROM biodata";
        const { rows: rBio } = await db.execute(queryBio);
        let parsedData = rBio.map(r => ({
           row: r.nip, NIP: r.nip, Nama: r.nama, Jenjang: r.jenjang, NIK: r.nik, NUPTK: r.nuptk, Tempat_Lahir: r.tempat_lahir,
           Tanggal_Lahir: r.tanggal_lahir, Jenis_Kelamin: r.jenis_kelamin, Agama: r.agama, Pangkat_Golongan: r.pangkat_golongan,
           Jabatan: r.jabatan, Unit_Kerja: r.unit_kerja, Email: r.email, No_HP: r.no_hp, Alamat: r.alamat,
           Status_Verifikasi: r.status_verifikasi, Catatan: r.catatan, Foto: r.foto, Ijazah: r.ijazah, Sertifikat: r.sertifikat,
           SK: r.sk, SKP: r.skp, Sehat: r.sehat, SKCK: r.skck, Pakta: r.pakta, Manajerial: r.manajerial, Lokasi_Ujian: r.lokasi_ujian,
           Tanggal_Ujian: r.tanggal_ujian, Waktu_Ujian: r.waktu_ujian, Sesi_Ujian: r.sesi_ujian, Ruangan_Ujian: r.ruangan_ujian, Username_CAT: r.username_cat, Password_CAT: r.password_cat
        }));
        result = isSingle ? (parsedData[0] || null) : parsedData;
        break;

        case 'getHasilCATPegawai':
        const sqlJoin = `SELECT u.*, b.nama as bio_nama, b.jenjang, b.nik as bio_nik, b.tempat_lahir, b.tanggal_lahir, 
                         b.jenis_kelamin, b.foto, b.tanggal_wawancara, b.waktu_wawancara, b.ruang_wawancara 
                         FROM users u LEFT JOIN biodata b ON u.nip = b.nip WHERE u.nip=?`;
        const rCAT = await db.execute({ sql: sqlJoin, args: [args[0]] });
        if(rCAT.rows.length > 0) result = rCAT.rows[0];
        else result = null;
        break;

      // PERBAIKAN 3: Aksi Baru Menyimpan Jadwal Wawancara
      case 'saveJadwalWawancaraMassal':
        let nipsWw = args[0]; let jdWw = args[1];
        for(let n of nipsWw) {
           await db.execute({ 
               sql: "UPDATE biodata SET tanggal_wawancara=?, waktu_wawancara=?, ruang_wawancara=? WHERE nip=?", 
               args: [jdWw.Tanggal_Wawancara, jdWw.Waktu_Wawancara, jdWw.Ruang_Wawancara, n] 
           });
        }
        result = `Jadwal Wawancara berhasil disimpan untuk ${nipsWw.length} peserta!`;
        break;

      case 'verifyBerkas':
        await db.execute({ sql: "UPDATE biodata SET status_verifikasi=?, catatan=? WHERE nip=?", args: [args[1], args[2], args[0]] });
        result = "Berhasil diverifikasi";
        break;

      case 'hapusPeserta':
        await db.execute({ sql: "DELETE FROM biodata WHERE nip=?", args: [args[0]] });
        result = "Data peserta berhasil dihapus";
        break;

      case 'saveJadwalMassal':
        let nips = args[0]; let jd = args[1];
        for(let n of nips) {
           let ucat = jd.Username_CAT || `TEST${n}`;
           let pcat = jd.Password_CAT || Math.floor(100000 + Math.random() * 900000).toString();
           await db.execute({ 
               sql: "UPDATE biodata SET lokasi_ujian=?, tanggal_ujian=?, waktu_ujian=?, sesi_ujian=?, ruangan_ujian=?, username_cat=?, password_cat=? WHERE nip=?", 
               args: [jd.Lokasi_Ujian, jd.Tanggal_Ujian, jd.Waktu_Ujian, jd.Sesi_Ujian, jd.Ruangan_Ujian, ucat, pcat, n] 
           });
        }
        result = `Jadwal & Akun CAT berhasil disimpan untuk ${nips.length} peserta!`;
        break;
    
    case 'updateFileAdmin':
        let [nipAdmin, fieldName, newUrl] = args;
        let colName = fieldName.toLowerCase(); // Menyamakan dengan nama kolom database
        await db.execute({ sql: `UPDATE biodata SET ${colName}=? WHERE nip=?`, args: [newUrl, nipAdmin] });
        result = "File peserta berhasil diperbarui";
        break;

      case 'uploadSingleFile':
        const fileData = args[0]; 
        const upUrl = await uploadToDrive(fileData.base64, `${fileData.nip}_${fileData.name}`, fileData.name === 'Foto');
        result = upUrl;
        break;

      case 'saveBiodata':
        let fd = args[0]; 
        let fUrls = args[1]; // Menerima URL Drive saja, ukuran request akan sangat kecil
        
        const chkWaktu = await db.execute("SELECT nilai FROM pengaturan WHERE kunci = 'Batas_Waktu'");
        if(chkWaktu.rows.length > 0 && chkWaktu.rows[0].nilai) {
            if(new Date() > new Date(chkWaktu.rows[0].nilai)) {
                return res.status(200).json({ result: "Maaf batas melengkapi data sudah selesai tidak menerima data baru lagi terimakasih atas kerjasamanya" });
            }
        }

        const finalFoto = fUrls['Foto'] || fd.old_Foto || '';
        const finalIjazah = fUrls['Ijazah'] || fd.old_Ijazah || '';
        const finalSertifikat = fUrls['Sertifikat'] || fd.old_Sertifikat || '';
        const finalSK = fUrls['SK'] || fd.old_SK || '';
        const finalSKP = fUrls['SKP'] || fd.old_SKP || '';
        const finalSehat = fUrls['Sehat'] || fd.old_Sehat || '';
        const finalSKCK = fUrls['SKCK'] || fd.old_SKCK || '';
        const finalPakta = fUrls['Pakta'] || fd.old_Pakta || '';
        const finalManajerial = fUrls['Manajerial'] || fd.old_Manajerial || '';

        const cekData = await db.execute({ sql: "SELECT nip FROM biodata WHERE nip=?", args: [fd.NIP] });

        if (cekData.rows.length > 0) {
            const updateQ = `UPDATE biodata SET 
              nama=?, jenjang=?, nik=?, nuptk=?, tempat_lahir=?, tanggal_lahir=?, jenis_kelamin=?, agama=?, pangkat_golongan=?, jabatan=?, unit_kerja=?, email=?, no_hp=?, alamat=?, status_verifikasi='Belum Verifikasi', catatan='',
              foto=?, ijazah=?, sertifikat=?, sk=?, skp=?, sehat=?, skck=?, pakta=?, manajerial=? 
              WHERE nip=?`;
            
            await db.execute({ sql: updateQ, args: [ fd.Nama, fd.Jenjang, fd.NIK, fd.NUPTK, fd.Tempat_Lahir, fd.Tanggal_Lahir, fd.Jenis_Kelamin, fd.Agama, fd.Pangkat_Golongan, fd.Jabatan, fd.Unit_Kerja, fd.Email, fd.No_HP, fd.Alamat, finalFoto, finalIjazah, finalSertifikat, finalSK, finalSKP, finalSehat, finalSKCK, finalPakta, finalManajerial, fd.NIP ] });
        } else {
            const insertQ = `INSERT INTO biodata 
              (nip, nama, jenjang, nik, nuptk, tempat_lahir, tanggal_lahir, jenis_kelamin, agama, pangkat_golongan, jabatan, unit_kerja, email, no_hp, alamat, status_verifikasi, catatan, foto, ijazah, sertifikat, sk, skp, sehat, skck, pakta, manajerial)
            VALUES 
              (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Belum Verifikasi', '', ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            
            await db.execute({ sql: insertQ, args: [ fd.NIP, fd.Nama, fd.Jenjang, fd.NIK, fd.NUPTK, fd.Tempat_Lahir, fd.Tanggal_Lahir, fd.Jenis_Kelamin, fd.Agama, fd.Pangkat_Golongan, fd.Jabatan, fd.Unit_Kerja, fd.Email, fd.No_HP, fd.Alamat, finalFoto, finalIjazah, finalSertifikat, finalSK, finalSKP, finalSehat, finalSKCK, finalPakta, finalManajerial ] });
        }
        
        result = "Data berhasil disimpan dan terkirim ke Admin!";
        break;

      default:
        throw new Error(`Action '${action}' tidak dikenali oleh server.`);
    }
    
    return res.status(200).send(JSON.stringify({ result }, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    ));

  } catch (error) {
    console.error("Vercel Server Error:", error);
    // Mengembalikan JSON standar agar bisa diparsing oleh frontend
    return res.status(500).json({ error: error.message });
  }
}
