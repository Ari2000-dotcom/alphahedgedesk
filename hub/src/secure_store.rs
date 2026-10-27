//! Small secrets encrypted at rest with Windows DPAPI (same approach as
//! QuantDesk's `secure_store.rs`). `CryptProtectData` ties the bytes to this
//! Windows user on this PC: another account, another machine, or the file
//! copied elsewhere cannot decrypt them, and there is no key for us to keep.
//!
//! Off Windows (a Linux VPS) there is no DPAPI; callers fall back to a
//! file readable only by the service user and say so in the log.

pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    imp::protect(plain)
}

pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
    imp::unprotect(sealed)
}

#[cfg(windows)]
mod imp {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    /// # Safety
    /// `blob` must be an output blob a successful DPAPI call just filled.
    unsafe fn take(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let out = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec();
        LocalFree(blob.pbData.cast());
        out
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr().cast_mut() };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        // SAFETY: `input` points at `plain` for its length and DPAPI only reads it;
        // `output` is DPAPI's to fill and `take` frees it.
        let ok = unsafe { CryptProtectData(&input, null(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) };
        if ok == 0 {
            return Err(format!("DPAPI could not encrypt: {}", std::io::Error::last_os_error()));
        }
        // SAFETY: the call above succeeded and filled `output`.
        Ok(unsafe { take(output) })
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB { cbData: sealed.len() as u32, pbData: sealed.as_ptr().cast_mut() };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        // SAFETY: as in `protect`.
        let ok = unsafe {
            CryptUnprotectData(&input, null_mut(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        };
        if ok == 0 {
            return Err(format!("DPAPI could not decrypt: {}", std::io::Error::last_os_error()));
        }
        // SAFETY: the call above succeeded and filled `output`.
        Ok(unsafe { take(output) })
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(plain.to_vec())
    }
    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
        Ok(sealed.to_vec())
    }
}
