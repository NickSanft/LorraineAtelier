//! Pure stroke recognizer — a faithful, line-for-line port of the prototype's JS
//! classifier (`mockup/Atelier.dc.html`, the `classify` / `analyzeRing` /
//! `_triOrient2` family). No Tauri, no `windows`, no `unsafe`: it is unit-tested
//! and validated against a golden corpus dumped from the JS oracle
//! (`scripts/recognizer-oracle.mjs` → `tests/corpus/recognizer.json`, asserted by
//! `tests/recognizer_parity.rs`). Keeping this a pure module means parity tests run
//! on any host and the recognizer can never depend on platform state.
//!
//! Coordinate convention matches the browser canvas: y grows DOWNWARD. The signed
//! shoelace area is therefore positive for a visually-clockwise ring; the prototype
//! labels `ccw = area > 0` (its "reversed/dismiss" gesture) — preserved verbatim so
//! cast-vs-dismiss can't silently invert.
#![forbid(unsafe_code)]

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Classification {
    /// "triangle-up" | "triangle-down" | "circle" | "square" | "secret"
    pub kind: String,
    /// "triangle" | "circle" | "square" | "secret"
    pub base: String,
    /// Pre-round neatness 8..=100 (caller may round for display).
    pub score: f64,
    pub n_c: usize,
    pub circ: f64,
    pub gap: f64,
    pub sideways: bool,
    pub jut_dir: i32,
    pub secret: bool,
    // Neatness sub-components (0..1), surfaced so the UI can show canon
    // Size/Steadiness/Symmetry meters and so asymmetry can raise the misfire odds.
    pub aspect: f64,     // w/h balance → Symmetry
    pub closure: f64,    // how closed the shape is → Steadiness
    pub regularity: f64, // corner-count / radius regularity → Steadiness
}

#[derive(Clone, Debug, PartialEq)]
pub struct RingResult {
    pub closed: bool,
    pub encloses: bool,
    pub ccw: bool,
    pub score: f64,
    pub circ: f64,
    pub gap: f64,
}

struct BBox {
    mnx: f64,
    mny: f64,
    mxx: f64,
    mxy: f64,
    w: f64,
    h: f64,
}

fn path_len(p: &[Pt]) -> f64 {
    let mut d = 0.0;
    for i in 1..p.len() {
        d += (p[i].x - p[i - 1].x).hypot(p[i].y - p[i - 1].y);
    }
    d
}

fn bbox(p: &[Pt]) -> BBox {
    let (mut mnx, mut mny, mut mxx, mut mxy) = (1e9_f64, 1e9_f64, -1e9_f64, -1e9_f64);
    for q in p {
        mnx = mnx.min(q.x);
        mny = mny.min(q.y);
        mxx = mxx.max(q.x);
        mxy = mxy.max(q.y);
    }
    BBox { mnx, mny, mxx, mxy, w: mxx - mnx, h: mxy - mny }
}

/// Signed shoelace area (y-down). Positive == visually clockwise.
fn signed_area(p: &[Pt]) -> f64 {
    let n = p.len();
    if n == 0 {
        return 0.0;
    }
    let mut a = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        a += p[i].x * p[j].y - p[j].x * p[i].y;
    }
    a / 2.0
}

/// Signed angle from vector a to vector b: `atan2(cross, dot)`.
fn ang_between(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let cr = ax * by - ay * bx;
    let dt = ax * bx + ay * by;
    cr.atan2(dt)
}

/// Arc-length resample to `n` points. Faithful port of the JS in-place `splice`
/// walk (the prototype inserts each interpolated point back into the working array
/// so the next segment is measured from it). A Rust `Vec::insert(i, np)` inside a
/// length-tracking `while` loop reproduces that exactly.
pub fn resample(raw: &[Pt], n: usize) -> Vec<Pt> {
    let mut p: Vec<Pt> = raw.to_vec();
    if p.is_empty() {
        return p;
    }
    let interval = path_len(&p) / (n as f64 - 1.0);
    if !interval.is_finite() || interval == 0.0 {
        return p;
    }
    let mut d_acc = 0.0;
    let mut out: Vec<Pt> = vec![p[0]];
    let mut i = 1;
    while i < p.len() {
        let d = (p[i].x - p[i - 1].x).hypot(p[i].y - p[i - 1].y);
        if d_acc + d >= interval {
            let t = (interval - d_acc) / d;
            let np = Pt {
                x: p[i - 1].x + t * (p[i].x - p[i - 1].x),
                y: p[i - 1].y + t * (p[i].y - p[i - 1].y),
            };
            out.push(np);
            p.insert(i, np);
            d_acc = 0.0;
        } else {
            d_acc += d;
        }
        i += 1;
    }
    while out.len() < n {
        out.push(p[p.len() - 1]);
    }
    out.truncate(n);
    out
}

/// Classify the central sigil stroke. Mirrors the JS `classify(raw)`.
pub fn classify(raw: &[Pt]) -> Classification {
    let pts = resample(raw, 64);
    let bb = bbox(&pts);
    let diag = {
        let d = bb.w.hypot(bb.h);
        if d == 0.0 { 1.0 } else { d }
    };
    let last = pts.len() - 1;
    let gap = (pts[0].x - pts[last].x).hypot(pts[0].y - pts[last].y) / diag;

    // Corners via turning angle. For closed shapes (small gap), rotate so the seam
    // sits at the flattest point — otherwise a corner on the start/end seam is
    // never scanned and squares mis-count as 3.
    let step = 3usize;
    let n0 = pts.len();
    let mut turn = vec![0.0f64; n0];
    for i in 0..n0 {
        let pa = pts[(i + n0 - step) % n0];
        let pb = pts[(i + step) % n0];
        let ax = pts[i].x - pa.x;
        let ay = pts[i].y - pa.y;
        let bx = pb.x - pts[i].x;
        let by = pb.y - pts[i].y;
        turn[i] = ang_between(ax, ay, bx, by).abs();
    }
    let mut start_idx = 0usize;
    if gap < 0.34 {
        let mut mn = f64::INFINITY;
        for i in 0..n0 {
            if turn[i] < mn {
                mn = turn[i];
                start_idx = i;
            }
        }
    }
    let rot: Vec<Pt> = if start_idx != 0 {
        pts[start_idx..].iter().chain(pts[..start_idx].iter()).copied().collect()
    } else {
        pts.clone()
    };

    // Marks = strong turning points along the (rotated) path; non-wrapping window.
    struct Mark {
        i: usize,
        ang: f64,
    }
    let mut marks: Vec<Mark> = Vec::new();
    if rot.len() > 2 * step {
        for i in step..rot.len() - step {
            let ax = rot[i].x - rot[i - step].x;
            let ay = rot[i].y - rot[i - step].y;
            let bx = rot[i + step].x - rot[i].x;
            let by = rot[i + step].y - rot[i].y;
            let ang = ang_between(ax, ay, bx, by).abs();
            if ang > 0.78 {
                marks.push(Mark { i, ang });
            }
        }
    }
    // Cluster nearby marks (within 4 samples), keeping the sharpest.
    let mut clusters: Vec<Mark> = Vec::new();
    for m in marks {
        if let Some(last) = clusters.last_mut() {
            if m.i - last.i <= 4 {
                if m.ang > last.ang {
                    last.i = m.i;
                    last.ang = m.ang;
                }
                continue;
            }
        }
        clusters.push(m);
    }
    let n_c = clusters.len();

    let peri = path_len(&pts);
    let area = signed_area(&pts).abs();
    let circ = if peri > 0.0 {
        (4.0 * std::f64::consts::PI * area) / (peri * peri)
    } else {
        0.0
    };

    // Secret seal: a pentacle / 5+-corner star, outside the normal vocabulary.
    if n_c >= 5 && gap < 0.62 {
        return Classification {
            kind: "secret".into(),
            base: "secret".into(),
            score: 88.0,
            n_c,
            circ,
            gap,
            sideways: false,
            jut_dir: 0,
            secret: true,
            aspect: 0.0,
            closure: 0.0,
            regularity: 0.0,
        };
    }

    let mut kind: String = if n_c >= 4 && gap < 0.5 {
        "square".into()
    } else if n_c == 3 {
        "triangle".into()
    } else if n_c <= 1 && circ > 0.6 {
        "circle".into()
    } else if n_c == 2 {
        "triangle".into()
    } else if circ > 0.62 {
        "circle".into()
    } else {
        "triangle".into()
    };

    let mut base = kind.clone();
    let mut sideways = false;
    let mut jut_dir = 0;
    if kind == "triangle" {
        let ori = tri_orient2(&pts, &bb);
        kind = ori.0;
        base = "triangle".into();
        sideways = ori.1;
        jut_dir = ori.2;
    }

    // Neatness.
    let aspect = 1.0 - (1.0f64).min((bb.w - bb.h).abs() / bb.w.max(bb.h).max(1.0));
    let clos = if kind == "circle" {
        (1.0 - gap / 0.5).max(0.0)
    } else {
        (1.0 - gap / 0.85).max(0.0) * 0.55 + 0.45
    };
    let reg = if kind == "circle" {
        let cx = (bb.mnx + bb.mxx) / 2.0;
        let cy = (bb.mny + bb.mxy) / 2.0;
        let rs: Vec<f64> = pts.iter().map(|q| (q.x - cx).hypot(q.y - cy)).collect();
        let mean = rs.iter().sum::<f64>() / rs.len() as f64;
        let denom = if mean == 0.0 { 1.0 } else { mean };
        let v = rs.iter().map(|b| (b - mean).abs()).sum::<f64>() / rs.len() as f64 / denom;
        (1.0 - v * 1.8).max(0.0)
    } else {
        let ideal = if kind == "square" { 4.0 } else { 3.0 };
        (1.0 - (n_c as f64 - ideal).abs() * 0.28).max(0.0)
    };
    let score = (8.0f64).max((100.0f64).min((aspect * 0.34 + clos * 0.3 + reg * 0.36) * 100.0));

    Classification {
        kind,
        base,
        score,
        n_c,
        circ,
        gap,
        sideways,
        jut_dir,
        secret: false,
        aspect,
        closure: clos,
        regularity: reg,
    }
}

/// Triangle apex orientation. Returns (kind, sideways, jut_dir).
fn tri_orient2(pts: &[Pt], bb: &BBox) -> (String, bool, i32) {
    let h = if bb.h == 0.0 { 1.0 } else { bb.h };
    let w = if bb.w == 0.0 { 1.0 } else { bb.w };
    let top_b: Vec<Pt> = pts.iter().copied().filter(|q| q.y <= bb.mny + h * 0.30).collect();
    let bot_b: Vec<Pt> = pts.iter().copied().filter(|q| q.y >= bb.mxy - h * 0.30).collect();
    let left_b: Vec<Pt> = pts.iter().copied().filter(|q| q.x <= bb.mnx + w * 0.30).collect();
    let right_b: Vec<Pt> = pts.iter().copied().filter(|q| q.x >= bb.mxx - w * 0.30).collect();
    let w_top = span_x(&top_b);
    let w_bot = span_x(&bot_b);
    let h_left = span_y(&left_b);
    let h_right = span_y(&right_b);
    // The apex sits in the band with the smallest perpendicular extent. Stable sort
    // preserves the [up, down, right, left] tie order of the JS Array.sort.
    let mut bands = [("up", w_top), ("down", w_bot), ("right", h_right), ("left", h_left)];
    bands.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    let apex = bands[0].0;
    let mut sideways = false;
    let mut jut_dir = 0;
    let kind = if apex == "down" {
        "triangle-down".to_string()
    } else if apex == "up" {
        "triangle-up".to_string()
    } else if w_bot >= w_top {
        "triangle-up".to_string()
    } else {
        "triangle-down".to_string()
    };
    if apex == "left" || apex == "right" {
        sideways = true;
        jut_dir = if apex == "right" { 1 } else { -1 };
    }
    (kind, sideways, jut_dir)
}

fn span_x(arr: &[Pt]) -> f64 {
    if arr.is_empty() {
        return 0.0;
    }
    let (mut mn, mut mx) = (1e9_f64, -1e9_f64);
    for q in arr {
        mn = mn.min(q.x);
        mx = mx.max(q.x);
    }
    mx - mn
}

fn span_y(arr: &[Pt]) -> f64 {
    if arr.is_empty() {
        return 0.0;
    }
    let (mut mn, mut mx) = (1e9_f64, -1e9_f64);
    for q in arr {
        mn = mn.min(q.y);
        mx = mx.max(q.y);
    }
    mx - mn
}

/// Analyze the enclosing ring stroke around `center` (the sigil centroid).
/// Mirrors the JS `analyzeRing(raw, center)`.
pub fn analyze_ring(raw: &[Pt], center: Pt) -> RingResult {
    let pts = resample(raw, 64);
    let bb = bbox(&pts);
    let diag = {
        let d = bb.w.hypot(bb.h);
        if d == 0.0 { 1.0 } else { d }
    };
    let last = pts.len() - 1;
    let gap = (pts[0].x - pts[last].x).hypot(pts[0].y - pts[last].y) / diag;
    let closed = gap < 0.3;
    let peri = path_len(&pts);
    let area = signed_area(&pts); // signed: drives ccw
    let acirc = area.abs();
    let circ = if peri > 0.0 {
        (4.0 * std::f64::consts::PI * acirc) / (peri * peri)
    } else {
        0.0
    };

    // Point-in-polygon (ray cast) for "ring encloses the sigil centre".
    let mut inside = false;
    let n = pts.len();
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (pts[i].x, pts[i].y);
        let (xj, yj) = (pts[j].x, pts[j].y);
        let denom = if (yj - yi) == 0.0 { 1e-9 } else { yj - yi };
        let intersect =
            ((yi > center.y) != (yj > center.y)) && (center.x < (xj - xi) * (center.y - yi) / denom + xi);
        if intersect {
            inside = !inside;
        }
        j = i;
    }

    let clos = (1.0 - gap / 0.5).max(0.0);
    let score = (10.0f64).max((100.0f64).min((clos * 0.5 + (1.0f64).min(circ) * 0.5) * 100.0));
    RingResult { closed, encloses: inside, ccw: area > 0.0, score, circ, gap }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn circle_pts(cx: f64, cy: f64, r: f64, n: usize, cw: bool) -> Vec<Pt> {
        (0..=n)
            .map(|i| {
                let t = i as f64 / n as f64 * std::f64::consts::TAU;
                let a = if cw { t } else { -t };
                Pt { x: cx + r * a.cos(), y: cy + r * a.sin() }
            })
            .collect()
    }

    #[test]
    fn circle_classifies_as_circle() {
        let c = classify(&circle_pts(150.0, 150.0, 100.0, 96, true));
        assert_eq!(c.kind, "circle");
        assert!(!c.secret);
    }

    #[test]
    fn ring_direction_sign() {
        let center = Pt { x: 150.0, y: 150.0 };
        let cw = analyze_ring(&circle_pts(150.0, 150.0, 100.0, 96, true), center);
        let ccw = analyze_ring(&circle_pts(150.0, 150.0, 100.0, 96, false), center);
        assert!(cw.closed && cw.encloses);
        assert!(ccw.closed && ccw.encloses);
        // y-down: clockwise winding has positive shoelace area → ccw flag true.
        assert!(cw.ccw);
        assert!(!ccw.ccw);
    }
}
