//! Surfing's ad-block kernel (Brave's `adblock` engine). Every export takes one input region and returns a response
//! frame; each input starts with the engine slot as a little-endian `u32`:
//!
//! - `filters_add`: slot, base64 of one whole filter list
//! - `filters_build`: slot — indexes the lists added so far
//! - `filters_resources`: slot, base64 of uBlock Origin's resources.json
//! - `filters_save`: slot, `u32` byte offset — base64 of the next piece of the saved engine
//! - `filters_load`: slot, `u8` last flag, base64 of a piece of a saved engine
//! - `filters_drop`: slot
//! - `filters_request`: slot, `u8` response phase, `url\nsourceUrl\ntype\nmethod` — the `filter.request` reply as JSON
//! - `filters_cosmetics`: slot, `{url, classes, ids, initial}` JSON — the `filter.cosmetics` reply as JSON

#[forbid(unsafe_code)]
pub mod kernel;

use std::cell::RefCell;

use kernel::Kernel;
use valley_plugin_abi::{ABI_VERSION, Status, encode_response, pack_region};

thread_local! {
    static KERNEL: RefCell<Kernel> = RefCell::new(Kernel::default());
}

fn leak(frame: Vec<u8>) -> u64 {
    let len = u32::try_from(frame.len()).unwrap_or(0);
    let ptr = Box::into_raw(frame.into_boxed_slice()).cast::<u8>() as usize;
    pack_region(u32::try_from(ptr).unwrap_or(0), len)
}

fn input<'a>(ptr: u32, len: u32) -> &'a [u8] {
    if len == 0 {
        return &[];
    }
    // SAFETY: the host wrote `len` bytes at `ptr`, a region it obtained from `valley_alloc`, and frees it only after
    // this call returns.
    unsafe { std::slice::from_raw_parts(ptr as usize as *const u8, len as usize) }
}

fn answer(ptr: u32, len: u32, run: impl FnOnce(&mut Kernel, u32, &[u8]) -> Result<Vec<u8>, String>) -> u64 {
    let bytes = input(ptr, len);
    let result = match bytes.split_first_chunk::<4>() {
        Some((slot, rest)) => KERNEL.with(|kernel| run(&mut kernel.borrow_mut(), u32::from_le_bytes(*slot), rest)),
        None => Err("input has no engine slot".to_owned()),
    };
    leak(match result {
        Ok(payload) => encode_response(Status::Ok, &payload),
        Err(message) => encode_response(Status::Error, message.as_bytes()),
    })
}

fn text(bytes: &[u8]) -> Result<&str, String> {
    std::str::from_utf8(bytes).map_err(|_| "input is not UTF-8".to_owned())
}

#[unsafe(no_mangle)]
pub extern "C" fn filters_add(ptr: u32, len: u32) -> u64 {
    answer(ptr, len, |kernel, slot, rest| {
        kernel.add(slot, kernel::decode_text(rest)?);
        Ok(Vec::new())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn filters_build(ptr: u32, len: u32) -> u64 {
    answer(ptr, len, |kernel, slot, _| {
        kernel.build(slot);
        Ok(Vec::new())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn filters_resources(ptr: u32, len: u32) -> u64 {
    answer(ptr, len, |kernel, slot, rest| Ok(kernel.resources(slot, &kernel::decode_text(rest)?)?.to_string().into_bytes()))
}

#[unsafe(no_mangle)]
pub extern "C" fn filters_save(ptr: u32, len: u32) -> u64 {
    answer(ptr, len, |kernel, slot, rest| {
        let offset = rest.first_chunk::<4>().map(|bytes| u32::from_le_bytes(*bytes)).ok_or("input has no offset")?;
        Ok(kernel.save(slot, offset as usize)?.into_bytes())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn filters_load(ptr: u32, len: u32) -> u64 {
    answer(ptr, len, |kernel, slot, rest| {
        let (&last, piece) = rest.split_first().ok_or("input has no last flag")?;
        kernel.load(slot, last != 0, piece)?;
        Ok(Vec::new())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn filters_drop(ptr: u32, len: u32) -> u64 {
    answer(ptr, len, |kernel, slot, _| {
        kernel.drop_slot(slot);
        Ok(Vec::new())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn filters_request(ptr: u32, len: u32) -> u64 {
    answer(ptr, len, |kernel, slot, rest| {
        let (&phase, fields) = rest.split_first().ok_or("input has no phase")?;
        let mut fields = text(fields)?.split('\n');
        let mut next = || fields.next().unwrap_or("");
        let (url, source, kind, method) = (next(), next(), next(), next());
        Ok(kernel.request(slot, phase != 0, url, source, kind, method)?.to_string().into_bytes())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn filters_cosmetics(ptr: u32, len: u32) -> u64 {
    answer(ptr, len, |kernel, slot, rest| Ok(kernel.cosmetics(slot, text(rest)?)?.to_string().into_bytes()))
}

#[unsafe(no_mangle)]
pub extern "C" fn valley_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn valley_alloc(len: u32) -> u32 {
    let ptr = Box::into_raw(vec![0_u8; len as usize].into_boxed_slice()).cast::<u8>() as usize;
    u32::try_from(ptr).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn valley_free(ptr: u32, len: u32) {
    if ptr == 0 {
        return;
    }
    // SAFETY: `ptr`/`len` describe a boxed slice this module leaked from `valley_alloc` or a response frame; the host
    // frees each region exactly once.
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr as usize as *mut u8, len as usize)) });
}

/// The frame-dispatched entry: the kernel is driven through its direct exports, so every method is unknown.
#[unsafe(no_mangle)]
pub extern "C" fn valley_call(_ptr: u32, _len: u32) -> u64 {
    leak(encode_response(Status::Error, b"surfing filters have no framed methods; call the filters_* exports"))
}
