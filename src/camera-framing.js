import * as THREE from 'three';

export function frameCharacterCamera(camera, root, framing) {
  let center;
  let viewHeight;
  if (framing) {
    // Shared world-space framing preserves actor scale regardless of hair or wardrobe bounds.
    center = new THREE.Vector3(0, framing.centerY, 0);
    viewHeight = framing.viewHeight;
  } else {
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    center = box.getCenter(new THREE.Vector3());
    viewHeight = Math.max(size.y, size.x / camera.aspect) * 1.2;
  }
  const distance = viewHeight * 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.position.set(center.x, center.y, center.z + distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}
