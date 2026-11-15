import { supabaseAdmin, db } from './supabase.js';

type Demo = {
  email: string;
  password: string;
  role: 'student' | 'tutor';
  fullName: string;
  phone: string;
};

const demos: Demo[] = [
  {
    email: 'estudiante@agorahub.co',
    password: 'Estudiante123',
    role: 'student',
    fullName: 'Laura Sánchez',
    phone: '+57 300 000 0000',
  },
  {
    email: 'tutor@agorahub.co',
    password: 'Tutor123',
    role: 'tutor',
    fullName: 'Julián Salcedo',
    phone: '+57 301 000 0000',
  },
];

const run = async (): Promise<void> => {
  const { data: roleRows, error: roleError } = await db
    .from('roles')
    .select('id, code')
    .in('code', ['student', 'tutor']);
  if (roleError) throw roleError;
  const roleMap = new Map((roleRows ?? []).map((row: { id: number; code: string }) => [row.code, row.id]));

  for (const demo of demos) {
    const { data: users, error: listError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listError) throw listError;
    const existing = users.users.find((user) => user.email?.toLowerCase() === demo.email);
    const authUser = existing
      ? (await supabaseAdmin.auth.admin.updateUserById(existing.id, { password: demo.password, email_confirm: true }))
          .data.user
      : (
          await supabaseAdmin.auth.admin.createUser({
            email: demo.email,
            password: demo.password,
            email_confirm: true,
            user_metadata: { full_name: demo.fullName, role: demo.role },
          })
        ).data.user;
    if (!authUser) throw new Error(`No se pudo crear o actualizar ${demo.email}`);

    const { error: userError } = await db
      .from('users')
      .upsert(
        { id: authUser.id, email: demo.email, full_name: demo.fullName, phone: demo.phone, status: 'active' },
        { onConflict: 'id' },
      );
    if (userError) throw userError;
    const roleId = roleMap.get(demo.role);
    if (!roleId) throw new Error(`Rol no encontrado: ${demo.role}`);
    const { error: membershipError } = await db
      .from('user_roles')
      .upsert({ user_id: authUser.id, role_id: roleId }, { onConflict: 'user_id,role_id' });
    if (membershipError) throw membershipError;

    if (demo.role === 'student') {
      const { error } = await db
        .from('student_profiles')
        .upsert(
          { user_id: authUser.id, education_level: 'Universidad', learning_goal: null },
          { onConflict: 'user_id' },
        );
      if (error) throw error;
    } else {
      const { error } = await db.from('tutor_profiles').upsert(
        {
          user_id: authUser.id,
          professional_title: 'Tutor de matemáticas y física',
          bio: 'Perfil demo para explorar el flujo de tutor.',
          teaching_modality: 'both',
          verification_status: 'verified',
          hourly_rate: 35000,
          average_rating: 0,
          review_count: 0,
        },
        { onConflict: 'user_id' },
      );
      if (error) throw error;
      const { data: subject, error: subjectError } = await db
        .from('subjects')
        .select('id')
        .eq('name', 'Matemáticas')
        .single();
      if (subjectError || !subject) throw subjectError ?? new Error('Materia Matemáticas no encontrada');
      const { error: tutorSubjectError } = await db
        .from('tutor_subjects')
        .upsert(
          { tutor_id: authUser.id, subject_id: subject.id, is_primary: true, hourly_rate: 35000 },
          { onConflict: 'tutor_id,subject_id' },
        );
      if (tutorSubjectError) throw tutorSubjectError;
      const { data: level, error: levelError } = await db
        .from('education_levels')
        .select('id')
        .eq('name', 'Universidad')
        .single();
      if (levelError || !level) throw levelError ?? new Error('Nivel Universidad no encontrado');
      const { error: tutorLevelError } = await db
        .from('tutor_education_levels')
        .upsert({ tutor_id: authUser.id, education_level_id: level.id }, { onConflict: 'tutor_id,education_level_id' });
      if (tutorLevelError) throw tutorLevelError;
    }
    console.log(`${existing ? 'updated' : 'created'} demo ${demo.role}`);
  }
  console.log('demo seed complete: profiles only; no requests or sessions created');
};

run().catch((error) => {
  console.error('demo_seed_failed', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
