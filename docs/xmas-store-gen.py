import random, math
random.seed(7)
W,H=1600,1000
o=[]
a=o.append
a(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid slice">')
a('''<defs>
<linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b2a1c"/><stop offset="1" stop-color="#14402b"/></linearGradient>
<linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6b3f22"/><stop offset="1" stop-color="#3e2312"/></linearGradient>
<linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9edef"/><stop offset="1" stop-color="#aab4ba"/></linearGradient>
<linearGradient id="dark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b4248"/><stop offset="1" stop-color="#1d2226"/></linearGradient>
<radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffe7a3" stop-opacity=".9"/><stop offset="1" stop-color="#ffe7a3" stop-opacity="0"/></radialGradient>
<pattern id="planks" width="160" height="40" patternUnits="userSpaceOnUse"><rect width="160" height="40" fill="none"/><path d="M0 40h160M80 0v40" stroke="#2c180b" stroke-width="2" opacity=".5"/></pattern>
</defs>''')
a(f'<rect width="{W}" height="{H}" fill="url(#wall)"/>')
# wall pattern: subtle diamonds
for y in range(30,760,70):
  for x in range((y//70%2)*45,W,90):
    a(f'<path d="M{x} {y-6}l6 6-6 6-6-6z" fill="#1e5a3c" opacity=".35"/>')
# floor
a(f'<rect y="790" width="{W}" height="{H-790}" fill="url(#floor)"/><rect y="790" width="{W}" height="{H-790}" fill="url(#planks)"/>')
a(f'<rect y="782" width="{W}" height="10" fill="#2a160a"/>')
# shelving units
def shelf(x0,w,y0,h,rows):
  a(f'<rect x="{x0-8}" y="{y0-8}" width="{w+16}" height="{h+16}" rx="4" fill="#5a3a22"/>')
  a(f'<rect x="{x0}" y="{y0}" width="{w}" height="{h}" fill="#2d1c10"/>')
  rh=h/rows
  for r in range(rows):
    yb=y0+(r+1)*rh
    a(f'<rect x="{x0}" y="{yb-8}" width="{w}" height="8" fill="#7a5233"/>')
    x=x0+6
    while x<x0+w-30:
      kind=random.random()
      if kind<.45:
        bw=min(random.randint(34,70),int(x0+w-6-x));
        if bw<24: break
        bh=random.randint(int(rh*.45),int(rh*.8))
        c=random.choice(['#c9a86a','#d8b97a','#b88f55','#e6d3a8','#c2a070'])
        a(f'<rect x="{x:.0f}" y="{yb-8-bh:.0f}" width="{bw}" height="{bh}" rx="2" fill="{c}"/>')
        a(f'<rect x="{x+6:.0f}" y="{yb-8-bh+8:.0f}" width="{bw-12}" height="{min(14,bh/4):.0f}" fill="#fff" opacity=".85"/>')
        a(f'<rect x="{x+6:.0f}" y="{yb-8-bh+12:.0f}" width="{(bw-12)*.6:.0f}" height="2.5" fill="#333" opacity=".6"/>')
        x+=bw+5
      elif kind<.75:
        # ink bottles CMYK
        for col in ['#00a3d9','#e0007a','#ffd400','#1a1a1a']:
          if x>x0+w-22: break
          bh=rh*.42
          a(f'<rect x="{x:.0f}" y="{yb-8-bh:.0f}" width="16" height="{bh:.0f}" rx="3" fill="{col}"/><rect x="{x+4:.0f}" y="{yb-14-bh:.0f}" width="8" height="7" fill="#ddd"/>')
          x+=20
        x+=6
      else:
        # stacked cartridges
        bw=min(random.randint(44,64),int(x0+w-6-x))
        if bw<24: break
        for k in range(3):
          col=random.choice(['#2e86c1','#c0392b','#f1c40f','#555','#16a085'])
          a(f'<rect x="{x:.0f}" y="{yb-8-(k+1)*14:.0f}" width="{bw}" height="12" rx="2" fill="{col}" opacity=".95"/>')
        x+=bw+6
  # tinsel along shelf top
  pts=" ".join(f"{x0+i*w/20:.0f},{y0-6+ (8 if i%2 else 0)}" for i in range(21))
  a(f'<polyline points="{pts}" fill="none" stroke="#e8c04a" stroke-width="5" stroke-linejoin="round" opacity=".9"/>')
shelf(40,360,180,560,5)
shelf(1210,350,180,560,5)
# central printer: wide format
def printer(x,y,w,label_col):
  a(f'<rect x="{x}" y="{y}" width="{w}" height="120" rx="14" fill="url(#metal)"/>')
  a(f'<rect x="{x+20}" y="{y+18}" width="{w-140}" height="34" rx="6" fill="#26303a"/>')
  a(f'<rect x="{x+w-100}" y="{y+16}" width="76" height="40" rx="6" fill="#1f2a33"/><rect x="{x+w-92}" y="{y+24}" width="34" height="18" rx="2" fill="#5fd3ff"/>')
  a(f'<rect x="{x}" y="{y+120}" width="{w}" height="14" fill="#8a959c"/>')
  # legs
  a(f'<rect x="{x+30}" y="{y+134}" width="16" height="{782-y-134}" fill="url(#dark)"/><rect x="{x+w-46}" y="{y+134}" width="16" height="{782-y-134}" fill="url(#dark)"/>')
  a(f'<rect x="{x+10}" y="{770}" width="56" height="12" rx="4" fill="#1d2226"/><rect x="{x+w-66}" y="{770}" width="56" height="12" rx="4" fill="#1d2226"/>')
  # printed media hanging
  mx=x+70; mw=w-140
  a(f'<rect x="{mx}" y="{y+134}" width="{mw}" height="190" fill="#fbfbf7"/>')
  # festive print on media: stripes + stars
  for i in range(8):
    a(f'<rect x="{mx+i*mw/8:.0f}" y="{y+150}" width="{mw/16:.0f}" height="150" fill="{label_col}" opacity=".85"/>')
  for i in range(6):
    sx=mx+30+i*(mw-60)/5; sy=y+225
    a(star(sx,sy,16,'#e8c04a'))
  a(f'<ellipse cx="{x+w/2}" cy="{y+330}" rx="{mw/2}" ry="10" fill="#d9d9d0"/>')
def star(cx,cy,r,c):
  p=[]
  for i in range(10):
    ang=-math.pi/2+i*math.pi/5; rr=r if i%2==0 else r*.45
    p.append(f"{cx+rr*math.cos(ang):.1f},{cy+rr*math.sin(ang):.1f}")
  return f'<polygon points="{" ".join(p)}" fill="{c}"/>'
printer(470,300,660,'#c0392b')
# small cutter/printer on bench right-center
a('<rect x="880" y="660" width="300" height="122" fill="#5a3a22"/><rect x="870" y="650" width="320" height="16" rx="3" fill="#7a5233"/>')
a('<rect x="900" y="600" width="250" height="52" rx="10" fill="url(#metal)"/><rect x="915" y="612" width="150" height="16" rx="4" fill="#26303a"/><rect x="1085" y="610" width="48" height="24" rx="4" fill="#1f2a33"/>')
# gift boxes on bench
for gx,gc,rb in [(905,'#c0392b','#e8c04a'),(980,'#1e8449','#e74c3c'),(1060,'#2e86c1','#f4f4f4')]:
  a(f'<rect x="{gx}" y="690" width="60" height="50" fill="{gc}"/><rect x="{gx+26}" y="690" width="8" height="50" fill="{rb}"/><rect x="{gx}" y="708" width="60" height="8" fill="{rb}"/><path d="M{gx+30} 690c-14-18-26-4-12 0zM{gx+30} 690c14-18 26-4 12 0z" fill="{rb}"/>')
# Christmas tree right of printer
tx,ty=1110,300
a(f'<rect x="{tx-14}" y="{ty+430}" width="28" height="52" fill="#5b3a1e"/>')
for i,(wd,yy) in enumerate([(120,ty+40),(160,ty+130),(200,ty+230),(240,ty+330)]):
  a(f'<path d="M{tx} {yy-60} L{tx+wd/2} {yy+80} L{tx-wd/2} {yy+80}Z" fill="{["#1b7a46","#17703f","#146638","#105c31"][i]}"/>')
a(star(tx,ty-28,30,'#f5c542'))
random.seed(3)
for i in range(26):
  yy=ty+random.uniform(20,400); half=(yy-(ty-20))/420*120
  xx=tx+random.uniform(-half*.85,half*.85)
  c=random.choice(['#e74c3c','#f5c542','#ecf0f1','#3498db','#e67e22'])
  a(f'<circle cx="{xx:.0f}" cy="{yy:.0f}" r="{random.choice([6,7,8])}" fill="{c}"/>')
# presents under tree
for gx,gw,gh,gc,rb in [(1040,54,40,'#c0392b','#f5c542'),(1100,46,52,'#f4f4f4','#c0392b'),(1150,58,34,'#1e8449','#f5c542')]:
  a(f'<rect x="{gx}" y="{782-gh}" width="{gw}" height="{gh}" fill="{gc}"/><rect x="{gx+gw/2-4}" y="{782-gh}" width="8" height="{gh}" fill="{rb}"/>')
# shoppers silhouettes (busy store)
def person(x,scale,col,basket=False):
  h=200*scale
  a(f'<g transform="translate({x} {782-h})">')
  a(f'<circle cx="{30*scale}" cy="{22*scale}" r="{20*scale}" fill="{col}"/>')
  a(f'<path d="M{5*scale} {h} L{2*scale} {70*scale} Q{30*scale} {40*scale} {58*scale} {70*scale} L{55*scale} {h}Z" fill="{col}"/>')
  # santa hat on some
  if basket:
    a(f'<rect x="{50*scale}" y="{110*scale}" width="{40*scale}" height="{28*scale}" rx="4" fill="none" stroke="#e8c04a" stroke-width="{4*scale}"/>')
  a('</g>')
random.seed(11)
for x,s in [(420,1.05),(560,.95),(700,1.1),(820,.9),(1290,1.0),(1420,1.08),(250,.92)]:
  person(x,s,random.choice(['#0a1f15','#0c2419','#081a11']),random.random()<.6)
# santa hats on two people
for x,s in [(560,.95),(1290,1.0)]:
  hx=x+30*s; hy=782-200*s+6*s
  a(f'<path d="M{hx-22*s} {hy} Q{hx} {hy-46*s} {hx+30*s} {hy-20*s} L{hx+20*s} {hy}Z" fill="#c0392b"/><rect x="{hx-24*s}" y="{hy-4*s}" width="{48*s}" height="{9*s}" rx="4" fill="#f4f4f4"/><circle cx="{hx+30*s}" cy="{hy-20*s}" r="{6*s}" fill="#f4f4f4"/>')
# string lights across top
pts=[]
for i in range(0,W+1,40): pts.append((i, 70+28*math.sin(i/W*math.pi*3)**2))
a('<polyline points="'+" ".join(f"{x},{y:.0f}" for x,y in pts)+'" fill="none" stroke="#06140d" stroke-width="3"/>')
cols=['#ff4d4d','#ffd84d','#4dff88','#4db8ff','#ff9f4d']
for k,(x,y) in enumerate(pts[1:-1]):
  c=cols[k%5]
  a(f'<circle cx="{x}" cy="{y+10:.0f}" r="22" fill="url(#glow)" opacity=".55"/><ellipse cx="{x}" cy="{y+10:.0f}" rx="6" ry="9" fill="{c}"/>')
# bunting / sign
a('<rect x="560" y="140" width="480" height="96" rx="10" fill="#7a1f1f" stroke="#e8c04a" stroke-width="5"/>')
a('<text x="800" y="185" text-anchor="middle" font-family="Georgia,serif" font-size="34" font-weight="700" fill="#f5e6b8">Parts &amp; Printers</text>')
a('<text x="800" y="220" text-anchor="middle" font-family="Georgia,serif" font-size="22" fill="#e8c04a" letter-spacing="4">SEASON’S GREETINGS</text>')
# wreaths on wall
for wx in [480,1120]:
  a(f'<circle cx="{wx}" cy="188" r="38" fill="none" stroke="#1b7a46" stroke-width="18"/>')
  for j in range(8):
    ang=j*math.pi/4; a(f'<circle cx="{wx+38*math.cos(ang):.0f}" cy="{188+38*math.sin(ang):.0f}" r="5" fill="#e74c3c"/>')
  a(f'<path d="M{wx-12} 226 l12 -10 l12 10 l-6 18 l-6 -10 l-6 10z" fill="#c0392b"/>')
# sparkles / snow
random.seed(5)
for i in range(90):
  x=random.uniform(0,W); y=random.uniform(0,760); r=random.choice([1.5,2,2.5,3])
  a(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="#fff" opacity="{random.uniform(.25,.7):.2f}"/>')
a('</svg>')
open('xmas-store.svg','w').write("".join(o))
