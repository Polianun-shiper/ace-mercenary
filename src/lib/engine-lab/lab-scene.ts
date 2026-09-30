/**
 * LabScene — 引擎实验室的预览场景
 * =====================================================================
 * 用户在 Engine Lab UI 里调参时，右侧屏幕实时显示这个场景：
 *
 *   - 一个程序化生成的「玩家机体」(简化 F-16 几何)
 *     让用户能看到自阴影、PBR 反射、AO 的效果
 *
 *   - 一个旋转的相机轨道 (鼠标可拖)
 *     从不同角度审视阴影质感
 *
 *   - 一个简化的沙漠地形 (大气透视参考)
 *
 *   - 几个浮空的几何体 (立方体/球体/圆环) 用于测试 PBR 反射
 *
 *   - 远景山脉 (大气透视距离参考)
 *
 * 调参时所有元素都会按当前 profile 重新渲染。
 */
import * as THREE from 'three';

/** 简化 F-16 几何 — 给 Engine Lab 预览用 (不加载完整模型) */
export function buildPreviewFighter(): THREE.Group {
  const g = new THREE.Group();

  // 机身 (流线型)
  const bodyGeo = new THREE.CylinderGeometry(0.6, 0.4, 8, 16);
  bodyGeo.rotateZ(Math.PI / 2);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x6b7280,
    metalness: 0.85,
    roughness: 0.3,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // 机鼻锥
  const noseGeo = new THREE.ConeGeometry(0.4, 2, 16);
  noseGeo.rotateZ(-Math.PI / 2);
  const nose = new THREE.Mesh(noseGeo, bodyMat);
  nose.position.x = 5;
  nose.castShadow = true;
  nose.receiveShadow = true;
  g.add(nose);

  // 座舱
  const canopyGeo = new THREE.SphereGeometry(0.5, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x102030,
    metalness: 0.2,
    roughness: 0.05,
    transparent: true,
    opacity: 0.85,
  });
  const canopy = new THREE.Mesh(canopyGeo, canopyMat);
  canopy.position.set(1.5, 0.55, 0);
  canopy.scale.set(1.6, 1.0, 0.9);
  canopy.castShadow = true;
  canopy.receiveShadow = true;
  g.add(canopy);

  // 主翼 (三角形)
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0);
  wingShape.lineTo(-2.5, 4.5);
  wingShape.lineTo(-1.5, 4.5);
  wingShape.lineTo(1.5, 0);
  wingShape.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.15, bevelEnabled: false });
  wingGeo.center();
  const wingMat = new THREE.MeshStandardMaterial({
    color: 0x4a5568,
    metalness: 0.7,
    roughness: 0.4,
  });
  const wingL = new THREE.Mesh(wingGeo, wingMat);
  wingL.position.set(-0.5, -0.1, 1.6);
  wingL.rotation.x = -Math.PI / 2;
  wingL.castShadow = true;
  wingL.receiveShadow = true;
  g.add(wingL);
  const wingR = wingL.clone();
  wingR.position.z = -1.6;
  g.add(wingR);

  // 垂尾
  const tailShape = new THREE.Shape();
  tailShape.moveTo(0, 0);
  tailShape.lineTo(-2, 2.2);
  tailShape.lineTo(-1.5, 2.2);
  tailShape.lineTo(0.5, 0);
  tailShape.closePath();
  const tailGeo = new THREE.ExtrudeGeometry(tailShape, { depth: 0.12, bevelEnabled: false });
  const tail = new THREE.Mesh(tailGeo, wingMat);
  tail.position.set(-3.5, 0.3, 0);
  tail.rotation.y = 0;
  tail.castShadow = true;
  tail.receiveShadow = true;
  g.add(tail);

  // 平尾
  const hStabGeo = new THREE.ExtrudeGeometry(
    (() => {
      const s = new THREE.Shape();
      s.moveTo(0, 0);
      s.lineTo(-1.5, 1.8);
      s.lineTo(-0.8, 1.8);
      s.lineTo(0.7, 0);
      s.closePath();
      return s;
    })(),
    { depth: 0.1, bevelEnabled: false },
  );
  const hStabL = new THREE.Mesh(hStabGeo, wingMat);
  hStabL.position.set(-3.5, 0, 1.0);
  hStabL.rotation.x = -Math.PI / 2;
  hStabL.castShadow = true;
  hStabL.receiveShadow = true;
  g.add(hStabL);
  const hStabR = hStabL.clone();
  hStabR.position.z = -1.0;
  g.add(hStabR);

  // 发动机喷口
  const exhaustGeo = new THREE.CylinderGeometry(0.5, 0.45, 0.4, 16);
  exhaustGeo.rotateZ(Math.PI / 2);
  const exhaustMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    metalness: 0.9,
    roughness: 0.6,
    emissive: 0xff5520,
    emissiveIntensity: 0.4,
  });
  const exhaust = new THREE.Mesh(exhaustGeo, exhaustMat);
  exhaust.position.x = -4.2;
  exhaust.castShadow = true;
  exhaust.receiveShadow = true;
  g.add(exhaust);

  // 几个导弹挂点
  const missileGeo = new THREE.CylinderGeometry(0.12, 0.12, 1.8, 8);
  missileGeo.rotateZ(Math.PI / 2);
  const missileMat = new THREE.MeshStandardMaterial({
    color: 0xdddddd,
    metalness: 0.3,
    roughness: 0.6,
  });
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(missileGeo, missileMat);
    m.position.set(i % 2 === 0 ? 0.5 : -0.5, -0.3, i < 2 ? 2.8 : -2.8);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }

  g.scale.setScalar(2.0);
  return g;
}

/** 沙漠地形 (大平面 + 程序化色彩) */
export function buildDesertTerrain(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(20000, 20000, 64, 64);
  // 起伏
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const h = Math.sin(x * 0.005) * 8 + Math.cos(y * 0.007) * 6 + Math.sin((x + y) * 0.02) * 2;
    pos.setZ(i, h);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd4a574,
    roughness: 0.95,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -8;
  mesh.receiveShadow = true;
  return mesh;
}

/** 远景山脉 (大气透视参考) */
export function buildMountainRange(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xb89054,
    roughness: 0.95,
    metalness: 0.0,
    flatShading: true,
  });
  for (let i = 0; i < 24; i++) {
    const r = 5000 + Math.random() * 3000;
    const a = (i / 24) * Math.PI * 2;
    const h = 400 + Math.random() * 600;
    const w = 800 + Math.random() * 600;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(w / 2, h, 6), mat);
    cone.position.set(Math.cos(a) * r, h / 2 - 20, Math.sin(a) * r);
    cone.castShadow = false;
    cone.receiveShadow = true;
    g.add(cone);
  }
  return g;
}

/** 浮空 PBR 测试几何体 (cube/sphere/torus) */
export function buildPBRTestRig(): THREE.Group {
  const g = new THREE.Group();
  const items: { geo: THREE.BufferGeometry; pos: [number, number, number] }[] = [
    { geo: new THREE.BoxGeometry(2, 2, 2), pos: [-8, 2, 0] },
    { geo: new THREE.SphereGeometry(1.2, 32, 24), pos: [-4, 2, 0] },
    { geo: new THREE.TorusGeometry(1, 0.4, 16, 32), pos: [0, 2, 0] },
    { geo: new THREE.TorusKnotGeometry(0.9, 0.3, 64, 16), pos: [4, 2, 0] },
  ];
  for (const item of items) {
    // 不同金属度 / 粗糙度
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.5 + Math.random() * 0.5,
      roughness: 0.1 + Math.random() * 0.5,
    });
    const m = new THREE.Mesh(item.geo, mat);
    m.position.set(...item.pos);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}
