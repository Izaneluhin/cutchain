"""Build fragment.html (hosted preview, images inlined) and index.html (deployable, images in img/) from fragment.src.html."""
import base64, re, pathlib, html

ROOT = pathlib.Path(__file__).parent
SRC = (ROOT / 'fragment.src.html').read_text()

CHECK = ('<svg viewBox="0 0 24 24" aria-label="verified"><circle cx="12" cy="12" r="11" fill="#1d9bf0"/>'
         '<path d="M7 12.5l3 3 7-7" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>')
ICONS = {
    'c': '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-3.6A8 8 0 1 1 21 12z"/></svg>',
    'r': '<svg viewBox="0 0 24 24"><path d="M4 8h12l-3-3M20 16H8l3 3"/></svg>',
    'l': '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
    'v': '<svg viewBox="0 0 24 24"><path d="M5 20v-7M12 20V4M19 20v-11"/></svg>',
}

POSTS = {
    'browomo': dict(name='Blaze', handle='@browomo', date='Aug 20', dur='1:06',
                    cap='Clavicular let THREE girls try to win him over, until one asked the question they ALL wanted answered 👀\n\n“Be honest… who was the best kisser?”',
                    c='516', r='1.5K', l='45K', v='6.6M', big='6.6M'),
    'marlow': dict(name='Marlow', handle='@marlowxbt', date='Sep 4', dur='0:40',
                   cap='Clavicular spent the entire night making moves on EVERY girl he met\n\nuntil guys waited outside and started a STREET FIGHT with him',
                   c='428', r='487', l='21K', v='3.8M', big='3.8M'),
    'selor': dict(name='Selor', handle='@selorxbt', date='Sep 2', dur='0:38',
                  cap='Clavicular thought he got a W at the club, but right after the kiss his face completely dropped and he started frantically wiping his tongue 👀\n\n“Wait, what the f*ck is in my mouth…”',
                  c='33', r='166', l='7.3K', v='1.6M', big='1.6M'),
    'cassien': dict(name='Cassien', handle='@cassienxbt', date='Sep 3', dur='0:29',
                    cap='One girl thought kissing Clavicular meant she had WON, but her BEST FRIEND waited until the end to make the only move that mattered 😏\n\n“She got the kiss… I got his number.”',
                    c='3', r='23', l='1.2K', v='674K', big='674K'),
}

def img(path, inline):
    if inline:
        return 'data:image/jpeg;base64,' + base64.b64encode((ROOT / path).read_bytes()).decode()
    return path

def post(key, inline, hero=False):
    p = POSTS[key]
    cls = 'post hero-post' if hero else 'post'
    return f'''<article class="{cls}">
        <div class="ph"><img class="av" src="{img(f'img/av_{key}.jpg', inline)}" alt="" width="40" height="40"><div><div class="nm">{p['name']} {CHECK}</div><div class="hd">{p['handle']} · {p['date']}</div></div></div>
        <p class="cap">{html.escape(p['cap'])}</p>
        <div class="still"><img src="{img(f'img/{key}_still.jpg', inline)}" alt="Clip posted by {p['handle']}"></div>
        <div class="st"><span>{ICONS['c']}{p['c']}</span><span>{ICONS['r']}{p['r']}</span><span>{ICONS['l']}{p['l']}</span><span class="vw">{ICONS['v']}{p['v']}</span></div>
        <div class="meta"><div class="big">{p['big']}<small>views · one clip</small></div><div class="who">{p['handle']}<br>{p['l']} likes · {p['r']} reposts</div></div>
      </article>'''

def render(inline):
    out = SRC
    out = out.replace('{{POST_MARLOW_HERO}}', post('marlow', inline, hero=True))
    for k in POSTS:
        out = out.replace('{{POST_' + k.upper() + '}}', post(k, inline))
    assert '{{' not in out, 'unreplaced placeholder'
    return out

frag = render(inline=True)
(ROOT / 'fragment.html').write_text(frag)

idx = render(inline=False)
head = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<meta name="description" content="Clip Twitch and Kick streams, post them with the CUT watermark, get paid every Sunday on Robinhood Chain by views.">\n')
m = re.match(r'(.*?)(<div class="page">.*)', idx, re.S)
(ROOT / 'index.html').write_text(head + m.group(1) + '</head>\n<body>\n' + m.group(2) + '\n</body>\n</html>\n')
print('fragment', len(frag) // 1024, 'KB; index', len(idx) // 1024, 'KB')
