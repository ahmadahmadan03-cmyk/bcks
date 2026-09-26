import { createClient } from '@libsql/client/web';

// HELPER: Fungsi untuk mengirim file Base64 dari Vercel ke Google Drive via GAS
async function uploadToDrive(base64Data, filename, isFoto) {
    const gasUrl = process.env.GAS_UPLOAD_URL;
    if (!gasUrl) throw new Error("GAS_UPLOAD_URL belum disetting di Vercel Environment Variables.");
    
    const response = await fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64: base64Data, filename: filename, isFoto: isFoto })
    });
    
    const data = await response.json();
    if (data.status !== "success") throw new Error("Gagal upload ke Google Drive: " + data.message);
    return data.url;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const dbUrl = process.env.TURSO_DATABASE_URL;
    const dbToken = process.env.TURSO_AUTH_TOKEN;

    if (!dbUrl || !dbToken) {
      throw new Error("Kredensial Database gagal dimuat. Pastikan TURSO_DATABASE_URL dan TURSO_AUTH_TOKEN sudah disetting di Vercel.");
    }

    const db = createClient({ url: dbUrl, authToken: dbToken });
    const { action, args } = req.body;
    let result;

    switch (action) {
      case 'loginUser':
        const nip = args[0]; const pass = args[1];
        const { rows: users } = await db.execute({ sql: "SELECT * FROM users WHERE nip = ? AND nik = ?", args: [nip, pass] });
        if (users.length > 0) result = { status: "success", role: users[0].role, nip: users[0].nip, nama: users[0].nama };
        else result = { status: "error", message: "NIP atau Password salah!" };
        break;

      case 'getPengaturanGlobal':
        const { rows: rPeng } = await db.execute("SELECT * FROM pengaturan");
        const { rows: rPengumuman } = await db.execute("SELECT * FROM pengumuman ORDER BY rowid DESC");
        
        let config = { Batas_Waktu: "", PengumumanList: [] };
        rPeng.forEach(row => {
           if(row.kunci === "Batas_Waktu" && row.nilai) {
              let tgl = new Date(row.nilai);
              if(!isNaN(tgl.getTime())) config.Batas_Waktu = tgl.toISOString();
           }
        });
        rPengumuman.forEach(p => {
           config.PengumumanList.push({ row: p.id, id: p.id, tanggal: p.tanggal, judul: p.judul, teks: p.teks, file: p.file_url });
        });
        result = config;
        break;

      case 'saveBatasWaktu':
        const cekBatas = await db.execute("SELECT * FROM pengaturan WHERE kunci = 'Batas_Waktu'");
        if (cekBatas.rows.length > 0) {
            await db.execute({ sql: "UPDATE pengaturan SET nilai = ? WHERE kunci = 'Batas_Waktu'", args: [args[0]] });
        } else {
            await db.execute({ sql: "INSERT INTO pengaturan (kunci, nilai) VALUES ('Batas_Waktu', ?)", args: [args[0]] });
        }
        result = "Pengaturan batas waktu berhasil disimpan!";
        break;

      case 'savePengumuman':
        let [pId, pJudul, pTeks, pFileObj, pOldFile, pActionRow] = args;
        let pFileUrl = pOldFile || "";
        
        if (pFileObj && pFileObj.base64) {
            pFileUrl = await uploadToDrive(pFileObj.base64, `Pengumuman_${new Date().getTime()}_${pFileObj.name}`, false);
        }
        let tglSkrg = new Date().toLocaleDateString('id-ID', {day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute:'2-digit'}) + " WIB";
        
        if (pActionRow && pActionRow !== "null" && pActionRow !== "") {
           await db.execute({ sql: "UPDATE pengumuman SET judul=?, teks=?, file_url=? WHERE id=?", args: [pJudul, pTeks, pFileUrl, pActionRow] });
           result = "Pengumuman berhasil diperbarui!";
        } else {
           let newId = "PENG-" + new Date().getTime();
           await db.execute({ sql: "INSERT INTO pengumuman (id, tanggal, judul, teks, file_url) VALUES (?, ?, ?, ?, ?)", args: [newId, tglSkrg, pJudul, pTeks, pFileUrl] });
           result = "Pengumuman baru berhasil ditambahkan!";
        }
        break;

      case 'deletePengumuman':
        await db.execute({ sql: "DELETE FROM pengumuman WHERE id=?", args: [args[0]] });
        result = "Pengumuman berhasil dihapus!";
        break;

      case 'getSemuaUsers':
        const { rows: rUsers } = await db.execute("SELECT * FROM users");
        result = rUsers.map(u => ({ row: u.nip, role: u.role, nip: u.nip, nik: u.nik, nama: u.nama }));
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
        let excelData = args[0];
        let count = 0;
        for (let row of excelData) {
            if (row && row.length >= 3 && row[0]) {
                let uNip = row[0].toString().trim(); let uNik = row[1].toString().trim(); let uNama = row[2].toString().trim();
                let cekUser = await db.execute({ sql: "SELECT nip FROM users WHERE nip=?", args: [uNip] });
                if(cekUser.rows.length > 0) {
                    await db.execute({ sql: "UPDATE users SET nik=?, nama=?, role='Pegawai' WHERE nip=?", args: [uNik, uNama, uNip] });
                } else {
                    await db.execute({ sql: "INSERT INTO users (role, nip, nik, nama) VALUES ('Pegawai', ?, ?, ?)", args: [uNip, uNik, uNama] });
                }
                count++;
            }
        }
        result = count + " User berhasil diimpor ke database.";
        break;

      case 'getSemuaBiodata':
      case 'getBiodataPegawai':
        // AUTO-PATCH: Tambahkan kolom manajerial jika belum ada di database
        try { await db.execute("ALTER TABLE biodata ADD COLUMN manajerial TEXT"); } catch(e) { /* Abaikan jika kolom sudah ada */ }

        const isSingle = action === 'getBiodataPegawai';
        let queryBio = isSingle ? { sql: "SELECT * FROM biodata WHERE nip=?", args: [args[0]] } : "SELECT * FROM biodata";
        const { rows: rBio } = await db.execute(queryBio);
        let parsedData = rBio.map(r => ({
           row: r.nip, NIP: r.nip, Nama: r.nama, Jenjang: r.jenjang, NIK: r.nik, NUPTK: r.nuptk, Tempat_Lahir: r.tempat_lahir,
           Tanggal_Lahir: r.tanggal_lahir, Jenis_Kelamin: r.jenis_kelamin, Agama: r.agama, Pangkat_Golongan: r.pangkat_golongan,
           Jabatan: r.jabatan, Unit_Kerja: r.unit_kerja, Email: r.email, No_HP: r.no_hp, Alamat: r.alamat,
           Status_Verifikasi: r.status_verifikasi, Catatan: r.catatan, Foto: r.foto, Ijazah: r.ijazah, Sertifikat: r.sertifikat,
           SK: r.sk, SKP: r.skp, Sehat: r.sehat, SKCK: r.skck, Pakta: r.pakta, Manajerial: r.manajerial, Lokasi_Ujian: r.lokasi_ujian,
           Tanggal_Ujian: r.tanggal_ujian, Waktu_Ujian: r.waktu_ujian, Sesi_Ujian: r.sesi_ujian, Username_CAT: r.username_cat, Password_CAT: r.password_cat
        }));
        result = isSingle ? (parsedData[0] || null) : parsedData;
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
           let ucat = jd.Username_CAT || `CAT${n.toString().substring(0,6)}`;
           let pcat = jd.Password_CAT || Math.floor(100000 + Math.random() * 900000);
           await db.execute({ sql: "UPDATE biodata SET lokasi_ujian=?, tanggal_ujian=?, waktu_ujian=?, sesi_ujian=?, username_cat=?, password_cat=? WHERE nip=?", args: [jd.Lokasi_Ujian, jd.Tanggal_Ujian, jd.Waktu_Ujian, jd.Sesi_Ujian, ucat, pcat, n] });
        }
        result = `Jadwal & Akun CAT berhasil disimpan untuk ${nips.length} peserta!`;
        break;

      case 'saveBiodata':
        let fd = args[0]; let filesData = args[1];
        
        // AUTO-PATCH
        try { await db.execute("ALTER TABLE biodata ADD COLUMN manajerial TEXT"); } catch(e) {}

        const chkWaktu = await db.execute("SELECT nilai FROM pengaturan WHERE kunci = 'Batas_Waktu'");
        if(chkWaktu.rows.length > 0 && chkWaktu.rows[0].nilai) {
            if(new Date() > new Date(chkWaktu.rows[0].nilai)) {
                return res.status(200).json({ result: "Maaf batas melengkapi data sudah selesai tidak menerima data baru lagi terimakasih atas kerjasamanya" });
            }
        }

        // Upload Paralel ke Google Drive
        let fUrls = {};
        const uploadPromises = filesData.filter(f => f.base64).map(async (f) => {
            const isFoto = (f.name === 'Foto');
            const url = await uploadToDrive(f.base64, `${fd.NIP}_${f.name}`, isFoto);
            return { name: f.name, url: url };
        });
        
        const uploadResults = await Promise.all(uploadPromises);
        uploadResults.forEach(res => { fUrls[res.name] = res.url; });

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
    
    return res.status(200).json({ result });

  } catch (error) {
    console.error("Vercel Server Error:", error);
    return res.status(500).json({ error: "Terjadi kesalahan sistem: " + error.message });
  }
}
