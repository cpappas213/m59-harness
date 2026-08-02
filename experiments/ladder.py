import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hp_advance import *
levels=sorted({25,30,35,40,45,50,55,60,65,70,75,80,90,100,105,115,120,130,135,145,150,160,165,170,190,200})
names={25:"mummy/spdrbaby",30:"centip/giarat",35:"slime/larva",40:"ant/specmum",45:"orc",
50:"duskrat/spider/ent/fungbst",55:"scorpion/zombie",60:"fairy/snowrat/flytrap/batrskel",
65:"redant",70:"frogman",75:"skel/dethspid/lvstatue",80:"orccave/orcwiza/troop",90:"troll/iceper",
100:"avshaman/grdworm/guard/tuskskel",105:"lupogg",115:"orcboss",120:"avar/dfly/nrthlwrm/stntroll",
130:"grdworm queen/daemskel",135:"avchief",145:"dflyq",150:"mollusk/thrasher/xeochctl",
160:"kriipa",165:"spdrquen",170:"yeti/xeofire",190:"xeowater",200:"cow/lich/ghost/dangel/lupking/shadowb/deadlich"}
print("H-range -> lowest monster level that is STRICTLY above H (viLevel > piBase_Max_Health)")
prev=20
for i,H in enumerate(range(20,151)):
    tgt=next((L for L in levels if L>H),None)
    if tgt is None: continue
    if i==0 or next((L for L in levels if L>H-1),None)!=tgt:
        pass
# build ranges
cur=None; start=None; out=[]
for H in range(20,151):
    tgt=next((L for L in levels if L>H),None)
    if tgt!=cur:
        if cur is not None: out.append((start,H-1,cur))
        cur=tgt; start=H
out.append((start,150,cur))
for a,b,L in out:
    surplus_lo=L-b; surplus_hi=L-a
    b_lo=max(0,min(10,tdiv(surplus_lo,5))); b_hi=max(0,min(10,tdiv(surplus_hi,5)))
    print(f"  H {a:>3}-{b:<3} -> viLevel {L:>3} ({names.get(L,'?')})  overshoot {surplus_lo}..{surplus_hi}, b={b_lo}..{b_hi}")
