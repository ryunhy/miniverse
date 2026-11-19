"""稠密合成房间构造器（synthetic）：地板+两面墙+家具团约 2 万点，环形相机，平面色照片。

写真实 COLMAP 二进制（cameras/images/points3D.bin）与 JPG，供 bench_switchback.py
驱动真实四阶段算法。单独运行可验证真实 structure.infer_structure 在此场景判 ok。
"""
from __future__ import annotations
import struct, sys, tempfile
from pathlib import Path
import numpy as np
REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "services" / "reconstruction"))
from app.miniature import structure as S
from app.miniature.tests.test_cache_slots import _rotmat2qvec

def write_scene(root: Path, n_cams=28):
    sparse = root / "colmap" / "sparse" / "0"; sparse.mkdir(parents=True)
    (root / "images").mkdir(parents=True)
    # cameras: PINHOLE 640x480 f=500
    with open(sparse/"cameras.bin","wb") as f:
        f.write(struct.pack("<Q",1)); f.write(struct.pack("<IiQQ",1,1,640,480))
        f.write(struct.pack("<4d",500,500,320,240))
    # ring cameras upright, looking at center
    imgs=[]
    for i in range(n_cams):
        th=2*np.pi*i/n_cams
        C=np.array([3.2*np.cos(th),3.2*np.sin(th),1.6])
        tgt=np.array([0,0,0.7]); fwd=(tgt-C); fwd/=np.linalg.norm(fwd)
        up=np.array([0,0,1.0]); right=np.cross(fwd,up); right/=np.linalg.norm(right)
        down=np.cross(fwd,right)
        R=np.stack([right,down,fwd]); t=-R@C
        imgs.append((i+1,_rotmat2qvec(R),t,f"img_{i:03d}.jpg"))
    with open(sparse/"images.bin","wb") as f:
        f.write(struct.pack("<Q",len(imgs)))
        for iid,q,t,name in imgs:
            f.write(struct.pack("<I",iid)); f.write(struct.pack("<4d",*q))
            f.write(struct.pack("<3d",*t)); f.write(struct.pack("<I",1))
            f.write(name.encode()+b"\x00"); f.write(struct.pack("<Q",0))
    # dense points: floor z=0, wall x=-2, wall y=1.5, furniture blobs
    rng=np.random.default_rng(7)
    pts=[]; rgb=[]
    gx,gy=np.meshgrid(np.linspace(-2,2,90),np.linspace(-1.5,1.5,70))
    floor=np.column_stack([gx.ravel(),gy.ravel(),np.zeros(gx.size)])
    floor+=rng.normal(0,0.005,floor.shape)
    pts.append(floor); rgb.append(np.tile([180,170,150],(len(floor),1)))
    wy,wz=np.meshgrid(np.linspace(-1.5,1.5,70),np.linspace(0,2.6,60))
    wallx=np.column_stack([np.full(wy.size,-2.0),wy.ravel(),wz.ravel()])
    wallx+=rng.normal(0,0.005,wallx.shape)
    pts.append(wallx); rgb.append(np.tile([200,200,210],(len(wallx),1)))
    wx,wz2=np.meshgrid(np.linspace(-2,2,90),np.linspace(0,2.6,60))
    wally=np.column_stack([wx.ravel(),np.full(wx.size,1.5),wz2.ravel()])
    wally+=rng.normal(0,0.005,wally.shape)
    pts.append(wally); rgb.append(np.tile([210,205,195],(len(wally),1)))
    for cx,cy,cz,sx,sy,sz,n in [(0.6,-0.4,0.4,0.5,0.4,0.4,1500),(-0.8,0.5,0.5,0.4,0.5,0.5,1500),(0.0,0.9,0.3,0.6,0.3,0.3,1200)]:
        b=rng.normal(0,1,(n,3))*np.array([sx,sy,sz])+np.array([cx,cy,cz])
        b[:,2]=np.abs(b[:,2])*0.5+cz*0.5
        pts.append(b); rgb.append(rng.integers(60,200,(n,3)))
    P=np.vstack(pts); RGB=np.vstack(rgb).astype(np.uint8)
    with open(sparse/"points3D.bin","wb") as f:
        f.write(struct.pack("<Q",len(P)))
        for i in range(len(P)):
            f.write(struct.pack("<Q",i+1)); f.write(struct.pack("<3d",*P[i]))
            f.write(struct.pack("<3B",*RGB[i])); f.write(struct.pack("<d",0.5))
            f.write(struct.pack("<Q",0))
    from PIL import Image
    for i in range(n_cams):
        Image.new("RGB",(640,480),(120+i%30,110,100)).save(root/"images"/f"img_{i:03d}.jpg")
    return len(P)

if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)/"scene"
        n=write_scene(root)
        print("points:",n)
        try:
            doc=S.infer_structure(root)
            print("status:",doc["status"])
            print("kept_walls:",doc.get("kept_walls"))
            print("visibility:",doc.get("visibility"))
            print("extent_nu:",doc.get("extent_nu"))
            print("diags:",doc.get("diagnostics"))
        except Exception as e:
            print("EXC:",type(e).__name__,e)