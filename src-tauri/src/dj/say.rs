//! What the DJ's voice says for the text it shows. The text-to-speech program reads some of what a host writes
//! wrong: "#1" as "hash one", "AC/DC" with a slash, "1999" as "nineteen hundred ninety-nine", "P!nk" with an
//! exclamation, "SZA" as "sha". Each sentence the captions show is said in a form that reads right, and as one
//! sentence to the program, so its timing maps back to the sentence shown.
//!
//! The program ends a sentence at ". ", "! " and "? ", except before a lowercase word or after an ellipsis; its
//! captions split the same way (`voice::split_sentences`), and the full stops of abbreviations, initials and
//! dotted acronyms, which the program would end a sentence at, are left out of what's said.

/// Names the voice gets wrong, how they're said, and whether they're matched in any case.
const NAMES: &[(&str, &str, bool)] = &[
    ("A$AP", "A-sap", true),
    ("SZA", "Sizza", true),
    ("Sade", "Shah-day", false),
    ("deadmau5", "deadmouse", true),
    ("will.i.am", "will I am", true),
    ("CHVRCHES", "Churches", true),
    ("Blink-182", "Blink one eighty-two", true),
    ("UB40", "U B 40", true),
    ("INXS", "In Excess", true),
    ("HAIM", "Hy-im", false),
    ("Haim", "Hy-im", false),
    ("IU", "I U", false),
    ("Måneskin", "Maw-neskin", false),
    ("EDM", "E D M", false),
    ("EP", "E P", false),
    ("w/", "with", true),
];

/// Abbreviations that never end a sentence, said in full, in any case. The last says whether one written without its
/// full stop, as it's written here, is too ("Dr Dre"; a bare "feat" is a word, "MS" another abbreviation).
const ABBREVIATIONS: &[(&str, &str, bool)] = &[
    ("Mr", "Mister", true),
    ("Mrs", "Missus", true),
    ("Ms", "Miz", true),
    ("Dr", "Doctor", true),
    ("St", "Saint", true),
    ("Mt", "Mount", true),
    ("vs", "versus", true),
    ("feat", "featuring", false),
    ("ft", "featuring", false),
];

/// Abbreviations that end no sentence when a number follows: "No. 1", "Vol. 2".
const BEFORE_NUMBERS: &[(&str, &str)] = &[("No", "number"), ("Vol", "volume"), ("Pt", "part"), ("Op", "opus")];

/// Said in full, but they can end a sentence: "… by Harry Connick Jr."
const ENDINGS: &[(&str, &str)] = &[("Jr", "Junior"), ("Sr", "Senior")];

/// Whether a full stop after `word` goes on with the sentence, where `next` is the word after it: before a lowercase
/// word, after an ellipsis, an abbreviation, an initial ("J. Cole") or a dotted acronym ("B.B. King").
pub fn keeps_going(word: &str, next: &str) -> bool {
    let word = word.trim_start_matches(is_opening).trim_end_matches(is_closing);
    let Some(core) = word.strip_suffix('.') else { return false };
    let next_starts = next.trim_start_matches(is_opening).chars().next();
    if next_starts.is_some_and(char::is_lowercase) || core.ends_with('.') {
        return true;
    }
    if abbreviation(core, true).is_some() {
        return true;
    }
    if BEFORE_NUMBERS.iter().any(|(a, _)| a.eq_ignore_ascii_case(core)) {
        return next_starts.is_some_and(|c| c.is_ascii_digit());
    }
    (is_initial(core) || acronym(core).is_some()) && next_starts.is_some_and(char::is_uppercase)
}

/// `sentence` (one of `voice::split_sentences`') as the voice should say it.
pub fn say(sentence: &str) -> String {
    let (body, ending) = split_ending(sentence);
    let words: Vec<&str> = body.split(' ').filter(|w| !w.is_empty()).collect();
    let said: Vec<String> = words.iter().enumerate().map(|(i, w)| say_word(w, words.get(i + 1).copied())).collect();
    let mut out = said.join(" ");
    if let Some(end) = ending {
        out.push_str(end);
    }
    out
}

/// The sentence's own ending: its run of ". ! ? …" (a "?!" or "..." together) and any closing quotes or brackets,
/// kept as it's written. The body's last word is read without it, as "U.S.A" in "… from the U.S.A."
fn split_ending(sentence: &str) -> (&str, Option<&str>) {
    let body = sentence.trim_end_matches(is_closing);
    if !body.ends_with(['.', '!', '?', '…']) {
        return (sentence, None);
    }
    let body = body.trim_end_matches(['.', '!', '?', '…']);
    (body, Some(&sentence[body.len()..]))
}

fn is_opening(c: char) -> bool {
    matches!(c, '"' | '“' | '‘' | '\'' | '(')
}

fn is_closing(c: char) -> bool {
    matches!(c, '"' | '”' | '’' | '\'' | ')')
}

/// A capital letter on its own, as an initial is.
fn is_initial(core: &str) -> bool {
    let mut chars = core.chars();
    chars.next().is_some_and(char::is_uppercase) && chars.next().is_none()
}

/// "U.S.A" or "B.B" read as letters: "U S A".
fn acronym(core: &str) -> Option<String> {
    let letters: Vec<&str> = core.split('.').collect();
    let single = |l: &&str| {
        let mut c = l.chars();
        c.next().is_some_and(char::is_alphabetic) && c.next().is_none()
    };
    (letters.len() >= 2 && letters.iter().all(single)).then(|| letters.join(" "))
}

/// The abbreviation `core` stands for, written with its full stop (`dotted`) or without.
fn abbreviation(core: &str, dotted: bool) -> Option<&'static str> {
    ABBREVIATIONS
        .iter()
        .find(|(a, _, bare)| if dotted { a.eq_ignore_ascii_case(core) } else { *bare && *a == core })
        .map(|(_, said, _)| *said)
}

fn name(core: &str) -> Option<&'static str> {
    NAMES
        .iter()
        .find(|(written, _, any_case)| core == *written || (*any_case && core.eq_ignore_ascii_case(written)))
        .map(|(_, said, _)| *said)
}

/// One word, with what's around it: opening quotes and brackets, then the word, then a possessive, closing quotes
/// and brackets, commas and the like, and a full stop that goes on with the sentence (`keeps_going`).
fn say_word(word: &str, next: Option<&str>) -> String {
    // An apostrophe opening a word is part of it ("'90s").
    let start = word.len() - word.trim_start_matches(|c| c != '\'' && is_opening(c)).len();
    let (lead, rest) = word.split_at(start);
    let trimmed = rest.trim_end_matches(|c: char| is_closing(c) || matches!(c, ',' | ';' | ':' | '.' | '…'));
    let (core, trail) = rest.split_at(trimmed.len());
    if let Some(said) = decade(core) {
        return format!("{lead}{said}{trail}");
    }
    let (core, owner) = match ["'s", "’s"].iter().find(|p| core.len() > p.len() && core.ends_with(**p)) {
        Some(p) => core.split_at(core.len() - p.len()),
        None => (core, ""),
    };
    // An abbreviation, initial or acronym the sentence goes on after is said without its full stop. Any other full
    // stop it goes on after (before a lowercase word, an ellipsis) stays, as the program reads it.
    if trail.starts_with('.') && !trail.starts_with("..") && keeps_going(&format!("{core}."), next.unwrap_or("")) {
        if let Some(said) = said_dotted(core, next) {
            return format!("{lead}{said}{owner}{}", &trail[1..]);
        }
    }
    format!("{lead}{}{owner}{trail}", say_core(core, next))
}

/// A word whose full stop is left out of what's said: an abbreviation in full, an initial or acronym as letters.
fn said_dotted(core: &str, next: Option<&str>) -> Option<String> {
    if let Some(said) = abbreviation(core, true) {
        return Some(said.to_owned());
    }
    if let Some((_, said)) = ENDINGS.iter().find(|(a, _)| a.eq_ignore_ascii_case(core)) {
        return Some((*said).to_owned());
    }
    let before_number = next.is_some_and(|n| n.starts_with(|c: char| c.is_ascii_digit()));
    if let Some((_, said)) = BEFORE_NUMBERS.iter().find(|(a, _)| before_number && a.eq_ignore_ascii_case(core)) {
        return Some((*said).to_owned());
    }
    acronym(core).or_else(|| is_initial(core).then(|| core.to_owned()))
}

/// The word itself, without what's around it; `next` is the word after.
fn say_core(core: &str, next: Option<&str>) -> String {
    if core.is_empty() {
        return String::new();
    }
    if let Some(said) = name(core) {
        return said.to_owned();
    }
    if let Some(said) = abbreviation(core, false) {
        return said.to_owned();
    }
    if let Some((_, said)) = ENDINGS.iter().find(|(a, _)| a.eq_ignore_ascii_case(core)) {
        return (*said).to_owned();
    }
    if let Some(letters) = acronym(core) {
        return letters;
    }
    if core == "+" {
        return "and".to_owned();
    }
    if let Some(said) = time(core, next).or_else(|| years(core)) {
        return said;
    }
    symbols(core)
}

/// "$", "!", "#", "/" and "+" inside a word: "Ke$ha", "P!nk", "#1", "AC/DC", "$5".
fn symbols(core: &str) -> String {
    let chars: Vec<char> = core.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let before = i.checked_sub(1).map(|j| chars[j]);
        let after = chars.get(i + 1).copied();
        let letter = |c: Option<char>| c.is_some_and(char::is_alphabetic);
        let alnum = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
        match c {
            '$' if after.is_some_and(|a| a.is_ascii_digit()) => {
                let amount: String =
                    chars[i + 1..].iter().take_while(|c| c.is_ascii_digit() || matches!(c, '.' | ',')).collect();
                let amount = amount.trim_end_matches(['.', ',']);
                out.push_str(amount);
                out.push_str(if amount == "1" { " dollar" } else { " dollars" });
                i += 1 + amount.chars().count();
                continue;
            }
            '$' if letter(before) || letter(after) => out.push('s'),
            '!' if letter(before) && letter(after) => out.push('i'),
            '#' if after.is_some_and(|a| a.is_ascii_digit()) => out.push_str("number "),
            // A hashtag's.
            '#' if letter(after) => {}
            '/' if alnum(before) && alnum(after) => out.push(' '),
            '+' if letter(before) && letter(after) => out.push_str(" and "),
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

/// A year as a host says it, when it would be read otherwise: "1999" as "19 99", "1905" "19 oh 5", "2011" "20 11".
/// A range ("2010-2015", "1999–2001") is from one to the other.
fn years(core: &str) -> Option<String> {
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if let Some((from, to)) = core.split_once(['-', '–']) {
        let to = year(to).or_else(|| (to.len() == 2 && digits(to)).then(|| to.to_owned()))?;
        return Some(format!("{} to {to}", year(from)?));
    }
    year(core).filter(|said| said != core)
}

/// Four digits from 1000 to 2099 as a year is said. The years from 2000 to 2009 and the round hundreds read right
/// as they are.
fn year(digits: &str) -> Option<String> {
    if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u32 = digits.parse().ok()?;
    let (hi, lo) = (n / 100, n % 100);
    Some(match n {
        1100..=1999 | 2010..=2099 if lo == 0 => digits.to_owned(),
        1100..=1999 | 2010..=2099 if lo < 10 => format!("{hi} oh {lo}"),
        1100..=1999 | 2010..=2099 => format!("{hi} {lo}"),
        1000..=2009 => digits.to_owned(),
        _ => return None,
    })
}

/// A decade in words: "90s", "'90s" and "90's" as "nineties", "1990s" as "19 nineties".
fn decade(core: &str) -> Option<String> {
    const TENS: [&str; 10] =
        ["", "tens", "twenties", "thirties", "forties", "fifties", "sixties", "seventies", "eighties", "nineties"];
    let digits = core.trim_start_matches(['\'', '’']);
    let digits = ["'s", "’s", "s"].iter().find_map(|s| digits.strip_suffix(s))?;
    if !matches!(digits.len(), 2 | 4) || !digits.ends_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let tens = usize::from(digits.as_bytes()[digits.len() - 2] - b'0');
    match digits.len() {
        2 if tens == 0 => Some("two thousands".into()),
        2 => Some(format!("{}{}", if tens == 1 { "twenty " } else { "" }, TENS[tens])),
        4 => {
            let century = &digits[..2];
            Some(match (century, tens) {
                ("20", 0) => "two thousands".into(),
                (_, 0) => format!("{century} hundreds"),
                _ => format!("{century} {}", TENS[tens]),
            })
        }
        _ => None,
    }
}

/// "2:00" as "2 o'clock" (or "2" before AM or PM), "2:30" as "2 30", "2:05" as "2 oh 5".
fn time(core: &str, next: Option<&str>) -> Option<String> {
    let (clock, suffix) = match core.find(|c: char| c.is_ascii_alphabetic()) {
        Some(i) => core.split_at(i),
        None => (core, ""),
    };
    if !suffix.is_empty() && !["am", "pm"].iter().any(|s| suffix.eq_ignore_ascii_case(s)) {
        return None;
    }
    let (h, m) = clock.split_once(':')?;
    let (hour, minute): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    if h.len() > 2 || m.len() != 2 || hour > 23 || minute > 59 {
        return None;
    }
    let meridiem = !suffix.is_empty()
        || next.is_some_and(|n| {
            let n = n.trim_end_matches(|c: char| !c.is_alphanumeric()).replace('.', "");
            n.eq_ignore_ascii_case("am") || n.eq_ignore_ascii_case("pm")
        });
    let said = match minute {
        0 if meridiem => hour.to_string(),
        0 => format!("{hour} o'clock"),
        1..=9 => format!("{hour} oh {minute}"),
        _ => format!("{hour} {minute}"),
    };
    Some(if suffix.is_empty() { said } else { format!("{said} {suffix}") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_numbers_symbols_and_names_as_a_host_would() {
        for (shown, said) in [
            ("That was the #1 song of 1999.", "That was the number 1 song of 19 99."),
            ("Here's AC/DC, live 24/7!", "Here's AC DC, live 24 7!"),
            ("Florence + the Machine, then Ke$ha and P!nk.", "Florence and the Machine, then Kesha and Pink."),
            ("Florence+the Machine.", "Florence and the Machine."),
            ("A$AP Rocky and $uicideboy$ with Ty Dolla $ign.", "A-sap Rocky and suicideboys with Ty Dolla sign."),
            ("SZA's new single, then deadmau5 and CHVRCHES.", "Sizza's new single, then deadmouse and Churches."),
            ("From the 90s, the '80s and the 1970s.", "From the nineties, the eighties and the 19 seventies."),
            ("The ’60s, the 90's and the 1900s.", "The sixties, the nineties and the 19 hundreds."),
            ("Hits of the '00s and the 10s.", "Hits of the two thousands and the twenty tens."),
            ("Back to the 2000s and 2010s.", "Back to the two thousands and 20 tens."),
            ("A hit in 2011, 1905 and 2005, 1900 too.", "A hit in 20 11, 19 oh 5 and 2005, 1900 too."),
            ("Their run from 2010-2015 was huge.", "Their run from 20 10 to 20 15 was huge."),
            ("From 1999–2001, and 2010-15.", "From 19 99 to 2001, and 20 10 to 15."),
            ("It's 2:00 AM, or 2:30, or 2:05pm, or 4:00.", "It's 2 AM, or 2 30, or 2 oh 5 pm, or 4 o'clock."),
            ("Tickets were $5, or $1.", "Tickets were 5 dollars, or 1 dollar."),
            ("A big EDM track, from her debut EP.", "A big E D M track, from her debut E P."),
            ("#throwback to 1999!", "throwback to 19 99!"),
        ] {
            assert_eq!(say(shown), said, "{shown}");
        }
    }

    #[test]
    fn leaves_out_full_stops_the_voice_would_end_a_sentence_at() {
        for (shown, said) in [
            ("That was Middle Child by J. Cole.", "That was Middle Child by J Cole."),
            ("Mr. Brightside, Dr. Dre feat. Snoop Dogg.", "Mister Brightside, Doctor Dre featuring Snoop Dogg."),
            ("Up next, Ms. Lauryn Hill and St. Vincent.", "Up next, Miz Lauryn Hill and Saint Vincent."),
            ("The No. 1 song, Vol. 2, Pt. 3 and Op. 9.", "The number 1 song, volume 2, part 3 and opus 9."),
            ("Made by B.B. King and M.I.A., from the U.S.A.", "Made by B B King and M I A, from the U S A."),
            ("Drake vs. Future, or Drake vs Kendrick.", "Drake versus Future, or Drake versus Kendrick."),
            ("That was Harry Connick Jr.", "That was Harry Connick Junior."),
            ("Harry Connick Jr. is next, then Sammy Davis Jr", "Harry Connick Junior is next, then Sammy Davis Junior"),
            ("They called him \"Mr.\"", "They called him \"Mister.\""),
        ] {
            assert_eq!(say(shown), said, "{shown}");
        }
    }

    #[test]
    fn leaves_the_rest_as_it_is() {
        for line in [
            "Here's one for the road.",
            "Wait for it… here it is!",
            "Hey... next song?!",
            "\"Hello,\" she said.",
            "It's 3.5 stars and 100% good, at No more than 1,000 plays.",
            "No.",
            "",
            "Plain words without an ending",
            "It's (feat) time",
            "MS Paint, a 0s and 1s thing, 0123 and 9:5.",
            "That was great. and then more.",
            "No. not now, at 25:61.",
            "Plan B is up, then hip-hop and Jay-Z.",
        ] {
            assert_eq!(say(line), line);
        }
        // Names are words only where they're names: "Sade" is matched as written.
        assert_eq!(say("sade"), "sade");
        assert_eq!(say("sza"), "Sizza");
    }

    #[test]
    fn knows_where_a_full_stop_goes_on_with_the_sentence() {
        let goes_on = [
            ("J.", "Cole"),
            ("Mr.", "Brightside"),
            ("feat.", "Drake"),
            ("(ft.", "Future"),
            ("No.", "1"),
            ("B.B.", "King"),
            ("great.", "and"),
            ("Hey...", "Next"),
        ];
        for (word, next) in goes_on {
            assert!(keeps_going(word, next), "{word} {next}");
        }
        let ends = [
            ("great.", "Next"),
            ("great.", "\"Next\""),
            ("great.", "2"),
            ("great.", ""),
            ("B.", ""),
            ("U.S.", "2"),
            ("No.", "Not"),
            ("Jr.", "Next"),
            ("1999.", "Next"),
            ("Hey!", "and"),
            ("U2", "Next"),
        ];
        for (word, next) in ends {
            assert!(!keeps_going(word, next), "{word} {next}");
        }
    }
}
